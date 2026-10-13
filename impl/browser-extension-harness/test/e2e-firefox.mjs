// End-to-end on Firefox: a real MV3 extension, installed as a temporary add-on
// in headless Firefox, answering eth_blockNumber through the real passthrough
// worker — with the harness running in the extension's background PAGE
// (`AnonRpcWorker` in its in-page mode), since Firefox has no offscreen documents.
//
// Playwright's Firefox cannot load extensions, so this drives Firefox through
// geckodriver's WebDriver API, whose `moz/addon/install` installs an unpacked
// extension temporarily. WebDriver may not open moz-extension:// pages either,
// so the extension reports each outcome to the stub server below.
//
// Needs Firefox (140+ measured) and geckodriver. Point FIREFOX_BIN and
// GECKODRIVER at them; without both, this test is skipped rather than failed.

import { build } from "esbuild";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { keccak_256 } from "@noble/hashes/sha3";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const BUNDLE = resolve(PKG, "../passthrough-worker/dist/passthrough-worker.js");
const { FIREFOX_BIN, GECKODRIVER } = process.env;

if (!FIREFOX_BIN || !GECKODRIVER) {
  console.log("  - Firefox e2e skipped: set FIREFOX_BIN and GECKODRIVER to run it");
  process.exit(0);
}

const cleanups = [];
const cleanup = async () => {
  for (const f of cleanups.splice(0).reverse()) {
    try {
      await f();
    } catch {
      /* best effort */
    }
  }
};
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => {
  failures++;
  console.error("  ✗ " + m);
};
const check = (cond, m, detail) => (cond ? ok(m) : bad(detail === undefined ? m : `${m}: ${JSON.stringify(detail)}`));

/* --- the stub chain + resolver ------------------------------------------ */
// The same shape as the Chromium e2e: a specifier read answered as the
// contract would, a resolver serving the pinned bundle, and an RPC endpoint
// that records who called it.

const bundle = await readFile(BUNDLE).catch(() => null);
if (!bundle) {
  console.error(`❌ passthrough worker bundle missing: ${BUNDLE} (run npm run build --workspaces)`);
  process.exit(1);
}
const workerHash = "0x" + Buffer.from(keccak_256(bundle)).toString("hex");
const SPECIFIER = "0x4fd77be300f31c5fe6ab266d35d27750a3478d27";
const SPECIFIER_PROBE = "0x000000000000000000000000000000000000beef";

const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
const word = (n) => pad(n.toString(16));
const selector = (sig) => "0x" + Buffer.from(keccak_256(Buffer.from(sig))).toString("hex").slice(0, 8);
function encodeStringArray(strings) {
  let offsets = "";
  let bodies = "";
  let cursor = strings.length * 32;
  for (const s of strings) {
    offsets += word(cursor);
    const bytes = Buffer.from(s, "utf8");
    const padded = Math.ceil(bytes.length / 32) * 32;
    bodies += word(bytes.length) + bytes.toString("hex").padEnd(padded * 2, "0");
    cursor += 32 + padded;
  }
  return "0x" + word(32) + word(strings.length) + offsets + bodies;
}

// A worker that reports its own environment: the privilege-separation check.
const probeTemplate = `
(async () => {
  const out = {};
  out.chrome = typeof chrome;
  out.browser = typeof browser;
  out.origin = self.location && self.location.origin ? String(self.location.origin) : "(none)";
  try {
    const r = await fetch(NOCORS_URL);
    out.noCors = "ALLOWED " + r.status;
  } catch (e) {
    out.noCors = "blocked";
  }
  anonRpcWorker.signalReady();
  for (;;) {
    const call = await anonRpcWorker.acceptCall();
    call.respond({ status: 200, headers: [], body: new TextEncoder().encode(JSON.stringify(out)) });
  }
})();
`;
let probeBytes = Buffer.alloc(0);
let probeHash = "";

let bundleFetches = 0;
let probeFetches = 0;
const rpcOrigins = new Set();
const reports = {};
// Bundle fetches as of the first case's report; later cases fetch too (the
// cross-origin one is only refused after the specifier read and bundle fetch).
let bundleFetchesForFirstWorker = -1;

const server = createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.url === "/worker.js") {
    bundleFetches++;
    res.writeHead(200, { ...cors, "content-type": "text/javascript" });
    return res.end(bundle);
  }
  if (req.url === "/probe-worker.js") {
    // NO cors headers: only a context holding the host permission can read it.
    probeFetches++;
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(probeBytes);
  }
  if (req.url === "/nocors") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"ok":true}');
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url.startsWith("/report/")) {
      const name = req.url.slice("/report/".length);
      reports[name] = JSON.parse(body);
      if (name === "blockNumber") bundleFetchesForFirstWorker = bundleFetches;
      res.writeHead(204, cors);
      return res.end();
    }
    let msg = {};
    try {
      msg = JSON.parse(body || "{}");
    } catch {
      /* answered as an error below */
    }
    const send = (result) => {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, result }));
    };
    if (msg.method === "eth_call") {
      const data = msg.params?.[0]?.data;
      const probe = (msg.params?.[0]?.to ?? "").toLowerCase() === SPECIFIER_PROBE;
      if (data === selector("workerHash()")) return send("0x" + pad(probe ? probeHash : workerHash));
      if (data === selector("workerResolvers()")) {
        return send(encodeStringArray([`${ORIGIN}${probe ? "/probe-worker.js" : "/worker.js"}`]));
      }
    }
    if (msg.method === "eth_blockNumber") {
      rpcOrigins.add(req.headers.origin ?? "(none)");
      return send("0x1312d00");
    }
    res.writeHead(404, cors);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
cleanups.push(() => new Promise((r) => server.close(r)));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
probeBytes = Buffer.from(probeTemplate.replace("NOCORS_URL", JSON.stringify(`${ORIGIN}/nocors`)));
probeHash = "0x" + Buffer.from(keccak_256(probeBytes)).toString("hex");

/* --- assemble the extension --------------------------------------------- */

const extDir = await mkdtemp(resolve(tmpdir(), "anon-rpc-ext-firefox-"));
cleanups.push(() => rm(extDir, { recursive: true, force: true }));
await cp(resolve(PKG, "dist/static/anon-rpc"), resolve(extDir, "anon-rpc"), { recursive: true });
await build({
  entryPoints: [resolve(PKG, "example-firefox/background.ts")],
  outfile: resolve(extDir, "background.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
  define: {
    __TEST_ORIGIN__: JSON.stringify(ORIGIN),
    __SPECIFIER__: JSON.stringify(SPECIFIER),
    __SPECIFIER_PROBE__: JSON.stringify(SPECIFIER_PROBE),
  },
});
await cp(resolve(PKG, "example-firefox/background.html"), resolve(extDir, "background.html"));
const manifest = JSON.parse(await readFile(resolve(PKG, "example-firefox/manifest.json"), "utf8"));
await writeFile(resolve(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));

/* --- run it -------------------------------------------------------------- */

const driverPort = 4444 + Math.floor(Math.random() * 1000);
const driver = spawn(GECKODRIVER, ["--port", String(driverPort)], { stdio: "ignore" });
cleanups.push(() => driver.kill());

async function webdriver(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${driverPort}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const json = await res.json();
  if (json.value?.error) throw new Error(`${route}: ${json.value.error}: ${json.value.message}`);
  return json.value;
}

for (let i = 0; i < 50; i++) {
  try {
    await webdriver("GET", "/status");
    break;
  } catch {
    await sleep(200);
  }
}
const session = await webdriver("POST", "/session", {
  capabilities: { alwaysMatch: { "moz:firefoxOptions": { binary: FIREFOX_BIN, args: ["-headless"] } } },
});
cleanups.push(() => webdriver("DELETE", `/session/${session.sessionId}`));
console.log(`  Firefox ${session.capabilities.browserVersion}`);
await webdriver("POST", `/session/${session.sessionId}/moz/addon/install`, { path: extDir, temporary: true });

for (let i = 0; i < 120 && !reports.done; i++) await sleep(250);
if (!reports.done) bad("the extension did not finish within 30s", reports);

/* --- assertions ---------------------------------------------------------- */

const { blockNumber, probe, crossOrigin } = reports;
check(blockNumber?.ok && blockNumber.value === "0x1312d00", "eth_blockNumber answered through the worker", blockNumber);
check(bundleFetchesForFirstWorker === 1, "the bundle was fetched and verified in the background page", { bundleFetchesForFirstWorker });
check(rpcOrigins.size === 1 && rpcOrigins.has("null"), 'the worker\'s requests carry "Origin: null"', [...rpcOrigins]);
check(probeFetches === 1 && probe?.ok, "the background page fetched a bundle from a NO-CORS endpoint", { probeFetches, probe });
check(probe?.value?.chrome === "undefined" && probe?.value?.browser === "undefined", "worker code cannot reach the extension API", probe?.value);
check(probe?.value?.origin === "null", 'the worker\'s own origin is "null"', probe?.value);
check(probe?.value?.noCors === "blocked", "the worker CANNOT reach the same no-CORS endpoint", probe?.value);
check(crossOrigin?.ok === false && /§6|cross-origin|same-origin/i.test(crossOrigin.error), "a cross-origin iframeUrl is refused (§6)", crossOrigin);

await cleanup();
if (failures) {
  console.error(`❌ Firefox e2e: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("✅ Firefox e2e passed");
