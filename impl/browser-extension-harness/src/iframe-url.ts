// Shared by the offscreen-document and in-page workers: how a caller's
// iframeUrl becomes the URL the browser harness is handed.

import { chromeApi } from "./chrome-types.js";

/**
 * An extension-relative path becomes an extension URL; an absolute URL is
 * passed through untouched.
 *
 * The pass-through matters. `chrome.runtime.getURL` does not reject an absolute
 * URL, it rewrites it into an extension one — so a caller who passed a
 * cross-origin page would have their mistake silently turned into a
 * same-origin-looking URL, and §6's same-origin check downstream would see
 * nothing wrong. Handing the original through keeps that one check meaningful.
 */
export function resolveIframeUrl(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  return chromeApi().runtime.getURL(raw);
}
