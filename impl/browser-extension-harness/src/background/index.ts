// The background entry: the §5 API the extension calls, from a Chromium service
// worker or a Firefox background page alike.
export { AnonRpcWorker } from "./AnonRpcWorker.js";
export { DEFAULT_OFFSCREEN_URL, DEFAULT_IFRAME_URL } from "./OffscreenWorker.js";
export type { ExtensionWorkerInit } from "./OffscreenWorker.js";
export { ensureOffscreenDocument, closeOffscreenDocument } from "./offscreen.js";
export { ASSET_PATH, PKG_VERSION, assetUrl } from "./assets.js";
export type * from "@anon-rpc/browser-harness";
