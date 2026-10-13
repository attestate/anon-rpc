// The popup's script. Renders and forwards; it never constructs a worker.
//
// Two things about a popup shape this file. It is destroyed whenever it loses
// focus, so it cannot hold state — every reopen asks the service worker what is
// actually going on. And it is the only thing with a timer, so it drives the
// poll cadence while it is open and stops driving it when it closes, while the
// worker itself stays booted in the offscreen document.

import { CHAINS, PRESETS, type Preset } from "./presets.js";

declare const chrome: {
  runtime: { sendMessage(msg: unknown): Promise<unknown> };
};

const POLL_MS = 12_000; // ~mainnet block time
const DEFAULT_WATCH = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // beacon deposit contract

type Settings = {
  bootstrap: string;
  workerRpc: string;
  specifier: string;
  config: string;
  watch: string;
  preset?: string;
  bootstraps?: Record<string, string>;
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  preset: $<HTMLSelectElement>("preset"),
  presetNote: $<HTMLParagraphElement>("preset-note"),
  specifier: $<HTMLInputElement>("specifier"),
  config: $<HTMLTextAreaElement>("config"),
  configNote: $<HTMLParagraphElement>("config-note"),
  bootstrap: $<HTMLInputElement>("bootstrap"),
  workerRpc: $<HTMLInputElement>("worker-rpc"),
  copy: $<HTMLButtonElement>("copy"),
  watch: $<HTMLInputElement>("watch"),
  toggle: $<HTMLButtonElement>("toggle"),
  pill: $<HTMLSpanElement>("pill"),
  detail: $<HTMLParagraphElement>("detail"),
  balanceCard: $<HTMLElement>("balance-card"),
  balance: $<HTMLDivElement>("balance"),
  delta: $<HTMLDivElement>("delta"),
  checked: $<HTMLDivElement>("checked"),
  bootNote: $<HTMLSpanElement>("boot-note"),
  drawer: $<HTMLElement>("log-drawer"),
  logToggle: $<HTMLButtonElement>("log-toggle"),
  logLatest: $<HTMLSpanElement>("log-latest"),
  logCount: $<HTMLSpanElement>("log-count"),
  logClear: $<HTMLButtonElement>("log-clear"),
  log: $<HTMLDivElement>("log"),
};

/* --- §13 log drawer ------------------------------------------------------
   The rows live in the service worker (see background.ts): a popup is
   destroyed on blur and the worker keeps going without it, so a buffer kept
   here would forget everything that happened while you were not watching.
   This renders whatever the service worker has.

   Two sources share the stream. The "worker" rows are §13 log calls made by
   hash-pinned code inside the sandbox, relayed offscreen → service worker →
   here; the "demo" rows are this extension's own lifecycle. */

type LogRow = {
  at: number;
  src: "demo" | "worker";
  level: "debug" | "info" | "warn" | "error";
  msg: string;
};

/** Rendered rows, keyed by the buffer length already drawn. */
let drawn = 0;

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour12: false, minute: "2-digit", second: "2-digit" });

function renderLogs(rows: LogRow[]): void {
  // The buffer is a capped window, so it can shrink from the front as well as
  // grow at the back. Only an append is incremental; anything else redraws.
  const append = rows.length >= drawn && drawn > 0;
  if (!append) {
    els.log.replaceChildren();
    drawn = 0;
  }
  const pinned = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 24;

  for (const r of rows.slice(drawn)) {
    const row = document.createElement("div");
    row.className = `log-row log-${r.level}`;
    const at = document.createElement("span");
    at.className = "log-at";
    at.textContent = clock(r.at);
    const src = document.createElement("span");
    src.className = `log-src ${r.src}`;
    src.textContent = r.src;
    const msg = document.createElement("span");
    msg.className = "log-msg";
    // textContent: worker rows are strings chosen by the bundle, which is
    // precisely the code this popup does not trust with its DOM.
    msg.textContent = r.msg;
    row.append(at, src, msg);
    els.log.appendChild(row);
  }
  drawn = rows.length;

  if (pinned) els.log.scrollTop = els.log.scrollHeight;
  els.logCount.textContent = String(rows.length);
  els.logLatest.textContent = rows.length ? rows[rows.length - 1].msg : "nothing yet";
}

async function refreshLogs(): Promise<void> {
  const res = await send<{ ok: boolean; rows?: LogRow[] }>({ type: "logs" });
  if (res.ok && res.rows) renderLogs(res.rows);
}

els.logToggle.addEventListener("click", () => {
  const open = els.drawer.classList.toggle("open");
  els.logToggle.setAttribute("aria-expanded", String(open));
  if (open) els.log.scrollTop = els.log.scrollHeight;
});

els.logClear.addEventListener("click", () => {
  void send({ type: "clearLogs" }).then(() => {
    drawn = 0;
    renderLogs([]);
  });
});

const fields = ["bootstrap", "workerRpc", "specifier", "config", "watch"] as const;

const send = <T>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

/**
 * Remember the typed fields, coalesced.
 *
 * The web demo writes to localStorage synchronously on every keystroke; this
 * has to cross to the service worker, so it waits for a pause instead. The two
 * RPC URLs are not sent at all — the service worker persists those only once
 * they have served.
 */
let saveTimer: number | undefined;
function saveTyped(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void send({
      type: "save",
      settings: {
        specifier: els.specifier.value.trim(),
        config: els.config.value,
        watch: els.watch.value.trim(),
        preset: els.preset.value,
      },
    });
  }, 300);
}

/* --- bootstrap RPC per chain --------------------------------------------
   The bootstrap RPC reads the specifier, so it has to be on the chain the
   specifier is published on. The field tracks which chain it was filled for;
   moving to a preset on another chain swaps in the URL proven there, or probes
   for one. Availability shifts, hence a probe rather than a hardcoded URL. */

/** Proven bootstrap URLs by chain, as the service worker last reported them. */
let bootstraps: Record<string, string> = {};
/** Chain the bootstrap field holds a URL for. */
let bootstrapChain: number | undefined;

/** The first public RPC on `chainId` that answers as that chain. */
async function probeRpc(chainId: number): Promise<string | undefined> {
  const want = "0x" + chainId.toString(16);
  for (const url of CHAINS[chainId]?.rpcs ?? []) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
        signal: AbortSignal.timeout(4000),
      });
      const body = (await resp.json()) as { result?: string };
      if (body.result === want) return url;
    } catch {
      // endpoint down, slow, or not answering as this chain: try the next
    }
  }
  return undefined;
}

/**
 * Probe for an RPC on `chainId` into an empty field. Never overwrites one the
 * user has typed into meanwhile — the probe is slower than a person is — nor
 * fills the bootstrap field for a chain the picker has since moved off.
 */
async function prefill(input: HTMLInputElement, chainId: number): Promise<void> {
  const restore = input.placeholder;
  input.placeholder = `checking public ${CHAINS[chainId].name} RPCs…`;
  try {
    const url = await probeRpc(chainId);
    const stale = input === els.bootstrap && bootstrapChain !== chainId;
    if (url && !input.value && !stale) input.value = url;
  } finally {
    input.placeholder = restore;
  }
}

/** Point the bootstrap field at `chainId`, if it is not already there. */
function useChain(chainId: number): void {
  if (chainId === bootstrapChain && els.bootstrap.value) return;
  bootstrapChain = chainId;
  els.bootstrap.value = bootstraps[chainId] ?? "";
  if (!els.bootstrap.value) void prefill(els.bootstrap, chainId);
}

/* --- presets ------------------------------------------------------------ */

const CUSTOM = PRESETS[PRESETS.length - 1];
const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? CUSTOM;
const presetBySpecifier = (addr: string): Preset | undefined =>
  PRESETS.find((p) => p.specifier && p.specifier.toLowerCase() === addr.toLowerCase());

for (const p of PRESETS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  const chain = p.chainId === undefined ? undefined : CHAINS[p.chainId];
  opt.textContent = chain?.testnet ? `${p.label} (${chain.name} testnet)` : p.label;
  els.preset.append(opt);
}

function renderPreset(p: Preset): void {
  els.presetNote.textContent = p.note ?? "";
  els.configNote.textContent = p.configNote ?? "";
}

function applyPreset(p: Preset): void {
  if (p.specifier) els.specifier.value = p.specifier;
  if (p.chainId !== undefined) useChain(p.chainId);
  // Always assigned, blank included: switching worker must not leave the
  // previous one's config behind for this one to be started with.
  els.config.value = p.config;
  renderPreset(p);
  saveTyped();
}

/* --- status ------------------------------------------------------------- */

type State = "idle" | "boot" | "ready" | "live" | "error";

function setStatus(state: State, detail: string): void {
  els.pill.className = `pill ${state === "idle" ? "" : state}`;
  els.pill.textContent =
    { idle: "idle", boot: "starting", ready: "ready", live: "watching", error: "error" }[state];
  els.detail.textContent = detail;
}

const WEI = 10n ** 18n;

function formatEth(wei: bigint, maxDecimals = 6): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = (abs / WEI).toLocaleString("en-US");
  const frac = (abs % WEI).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? "." + frac : ""}`;
}

/* --- the watcher -------------------------------------------------------- */

let timer: number | undefined;
let running = false;
let lastBalance: bigint | undefined;

function setControlsDisabled(disabled: boolean): void {
  for (const f of fields) els[f].disabled = disabled;
  els.preset.disabled = disabled;
  els.copy.disabled = disabled;
}

function showBalance(wei: bigint): void {
  els.balanceCard.hidden = false;
  els.balance.innerHTML = `${formatEth(wei)} <span class="unit">ETH</span>`;
  els.checked.textContent = `last checked ${new Date().toLocaleTimeString()}`;
  if (lastBalance !== undefined && wei !== lastBalance) {
    const diff = wei - lastBalance;
    const up = diff > 0n;
    els.delta.textContent = `${up ? "+" : "−"}${formatEth(diff < 0n ? -diff : diff, 8)} ETH`;
    els.delta.className = up ? "up" : "down";
    els.balance.classList.add(up ? "flash-up" : "flash-down");
    setTimeout(() => els.balance.classList.remove("flash-up", "flash-down"), 2500);
  }
  lastBalance = wei;
}

/** Say whether the last boot re-verified the bundle or reused a live worker. */
function noteBoot(booted?: { bootMs: number; cold: boolean }): void {
  if (!booted) return;
  els.bootNote.textContent = booted.cold
    ? `cold boot in ${booted.bootMs} ms — specifier read, bundle fetched, keccak256 verified`
    : `warm boot in ${booted.bootMs} ms — reattached to the worker already running offscreen`;
}

async function poll(): Promise<void> {
  if (!running) return;
  const t0 = Date.now();
  setStatus(lastBalance === undefined ? "ready" : "live", "eth_getBalance in flight through the worker…");
  const res = await send<{ ok: boolean; balance?: string; ms?: number; error?: string; booted?: { bootMs: number; cold: boolean } }>(
    { type: "poll" },
  );
  if (!running) return; // closed or stopped while in flight
  if (!res.ok) {
    // Keep polling: a transient RPC failure should not stop the watcher.
    void refreshLogs();
    setStatus("error", `${res.error} — retrying in ${POLL_MS / 1000} s`);
    return;
  }
  noteBoot(res.booted);
  void refreshLogs();
  showBalance(BigInt(res.balance!));
  setStatus("live", `request OK in ${res.ms} ms — next poll in ${POLL_MS / 1000} s`);
}

function beginPolling(): void {
  running = true;
  els.toggle.textContent = "Stop";
  setControlsDisabled(true);
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
}

async function start(): Promise<void> {
  const settings = Object.fromEntries(
    fields.map((f) => [f, els[f].value.trim()]),
  ) as unknown as Settings;
  settings.preset = els.preset.value;

  setStatus("boot", "reading specifier, fetching bundle, verifying keccak256…");
  els.toggle.disabled = true;
  const res = await send<{ ok: boolean; error?: string; runtime?: { bootMs: number; cold: boolean } }>({
    type: "start",
    settings,
  });
  els.toggle.disabled = false;
  if (!res.ok) {
    // No poll will follow to refresh the drawer, and a failed boot is exactly
    // when the worker's own last lines are worth reading.
    await refreshLogs();
    setStatus("error", res.error ?? "could not start");
    return;
  }
  noteBoot(res.runtime);
  beginPolling();
}

async function stop(): Promise<void> {
  void refreshLogs();
  running = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  els.toggle.textContent = "Start watching";
  setControlsDisabled(false);
  els.bootNote.textContent = "";
  setStatus("idle", "");
  await send({ type: "stop" });
}

els.toggle.addEventListener("click", () => void (running ? stop() : start()));
els.copy.addEventListener("click", () => {
  els.workerRpc.value = els.bootstrap.value;
});
els.specifier.addEventListener("input", () => {
  // Hand-editing away from a preset's address is a switch to custom.
  const match = presetBySpecifier(els.specifier.value.trim()) ?? CUSTOM;
  if (match.id !== els.preset.value) {
    els.preset.value = match.id;
    renderPreset(match);
    if (match.chainId !== undefined) useChain(match.chainId);
  }
  saveTyped();
});
els.config.addEventListener("input", saveTyped);
els.watch.addEventListener("input", saveTyped);
els.preset.addEventListener("change", () => applyPreset(presetById(els.preset.value)));

/* --- boot the popup ----------------------------------------------------- */

// The service worker is the source of truth. A popup that assumed "idle" on
// open would show the wrong thing every time it was reopened mid-watch, which
// is the normal case for a background watcher.
void (async () => {
  const { settings = {}, runtime = { running: false } } = await send<{
    settings: Partial<Settings>;
    runtime: { running: boolean; lastBalance?: string; bootMs?: number; cold?: boolean };
  }>({ type: "status" });

  for (const f of fields) els[f].value = settings[f] ?? "";
  bootstraps = settings.bootstraps ?? {};
  // Saves from before bootstraps existed were all mainnet.
  if (settings.bootstrap) {
    const hit = Object.entries(bootstraps).find(([, url]) => url === settings.bootstrap);
    bootstrapChain = hit ? Number(hit[0]) : 1;
  }
  if (!els.watch.value) els.watch.value = DEFAULT_WATCH;

  // Whatever happened while this popup did not exist is in the service
  // worker's buffer, which is the whole reason it lives there.
  await refreshLogs();

  const initial = els.specifier.value
    ? (presetBySpecifier(els.specifier.value) ?? CUSTOM)
    : presetById(settings.preset ?? PRESETS[0].id);
  els.preset.value = initial.id;
  // While a worker runs, its fields are the ones in force: leave them be.
  if (runtime.running) renderPreset(initial);
  else if (els.specifier.value) {
    renderPreset(initial);
    if (initial.chainId !== undefined) useChain(initial.chainId);
  } else applyPreset(initial);

  // Nothing proven yet: find endpoints that work rather than leaving the RPC
  // fields blank. The bootstrap follows the preset's chain (custom gets
  // mainnet); the worker RPC is mainnet whichever worker is picked, since
  // that is where the watched balance lives.
  if (!els.bootstrap.value) useChain(bootstrapChain ?? initial.chainId ?? 1);
  if (!els.workerRpc.value) void prefill(els.workerRpc, 1);

  if (runtime.lastBalance) {
    // Shown before the first poll of this popup so a reopen is not blank; the
    // delta baseline is set here so the next change reads against what the
    // user last saw.
    showBalance(BigInt(runtime.lastBalance));
    els.checked.textContent = "last checked in an earlier popup session";
  }
  if (runtime.running) {
    noteBoot(runtime.bootMs === undefined ? undefined : { bootMs: runtime.bootMs, cold: !!runtime.cold });
    beginPolling();
  }
})();
