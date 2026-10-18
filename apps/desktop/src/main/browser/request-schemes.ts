/*
 * What a native page's request may be, by its URL alone (the partition's `onBeforeRequest`).
 * http(s) requests are approved by the daemon through CDP Fetch; sockets are checked with the
 * page that opens them. Chromium's own PDF viewer (enabled with `plugins: true`) is the one
 * extension whose frames load, so a PDF opens in the tab as in Chrome; any other extension or
 * internal page is refused.
 */

export type RequestKind = "passive" | "fetched" | "socket" | "viewer" | "refused";

/** Chromium's built-in PDF viewer, a component extension with this fixed id. */
export const pdfViewerOrigin = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";
/** Shared WebUI resources the viewer's pages load. */
const viewerResources = ["chrome://resources/", "chrome-untrusted://resources/"];

const passive = new Set(["about:", "data:", "blob:", "devtools:"]);
const fetched = new Set(["http:", "https:"]);
const sockets = new Set(["ws:", "wss:"]);

export function requestKind(raw: string): RequestKind {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "refused";
  }
  if (url.username || url.password) return "refused";
  if (fetched.has(url.protocol)) return "fetched";
  if (passive.has(url.protocol)) return "passive";
  if (sockets.has(url.protocol)) return "socket";
  // Non-special schemes have no URL origin: compare the scheme and host.
  if (
    `${url.protocol}//${url.host}` === pdfViewerOrigin ||
    viewerResources.some((prefix) => raw.startsWith(prefix))
  )
    return "viewer";
  return "refused";
}
