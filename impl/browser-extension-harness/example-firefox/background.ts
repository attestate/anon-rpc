// The Firefox example extension's background page.
//
// Same integration as the Chrome example — a pre-existing RPC provider, an
// `AnonRpcWorker` constructed from it, `worker.fetch` wherever an anonymized
// call is wanted. The only difference is where the harness runs: Firefox's
// background is a page with a DOM, so `AnonRpcWorker` hosts it right here
// instead of in an offscreen document.
//
// The e2e cannot drive extension pages through WebDriver, so each case below
// reports its outcome to the test server instead.

import { AnonRpcWorker } from "@anon-rpc/browser-extension-harness";

// Substituted at build time (identifiers, so esbuild's `define` rewrites them).
declare const __TEST_ORIGIN__: string;
declare const __SPECIFIER__: string;
declare const __SPECIFIER_PROBE__: string;

const ORIGIN = __TEST_ORIGIN__;

/** A pre-existing RPC connection, as §4 assumes the host already has. */
const rpcProvider = {
  async request({ method, params }: { method: string; params?: unknown[] }) {
    const res = await fetch(`${ORIGIN}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  },
};

async function report(name: string, outcome: unknown): Promise<void> {
  await fetch(`${ORIGIN}/report/${name}`, { method: "POST", body: JSON.stringify(outcome) });
}

async function run(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await report(name, { ok: true, value: await fn() });
  } catch (e) {
    await report(name, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

const rpcCall = (method: string) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  }) satisfies RequestInit;

await run("blockNumber", async () => {
  const worker = new AnonRpcWorker({ address: __SPECIFIER__, preExisting: { rpcProvider } });
  await worker.ready;
  const res = await worker.fetch(`${ORIGIN}/rpc`, rpcCall("eth_blockNumber"));
  const { result } = await res.json();
  worker.close();
  return result;
});

await run("probe", async () => {
  const worker = new AnonRpcWorker({ address: __SPECIFIER_PROBE__, preExisting: { rpcProvider } });
  await worker.ready;
  const res = await worker.fetch(`${ORIGIN}/anything`);
  const environment = await res.json();
  worker.close();
  return environment;
});

await run("crossOrigin", async () => {
  const worker = new AnonRpcWorker({
    address: __SPECIFIER__,
    preExisting: { rpcProvider },
    iframeUrl: `${ORIGIN}/sandbox.html`,
  });
  await worker.ready;
  return "booted";
});

await report("done", true);
