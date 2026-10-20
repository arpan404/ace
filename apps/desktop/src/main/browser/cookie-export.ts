import type { Cookie } from "electron";

/** Cookies one reply carries at most: about what a browser keeps per profile. */
const maxCookies = 3_000;
/** Serialized bytes one reply carries at most, inside the relay's 1 MiB message limit. */
const maxBytes = 768 * 1024;

/**
 * A view's partition cookies for the daemon (`ace.cookies`), which carries them to ace's own
 * Chromium when this screen can't draw (it locked). Read from Electron's cookie store, so it
 * answers while nothing renders. Bounded by count and size; values are never logged.
 */
export function cookieExport(cookies: readonly Cookie[]): { cookies: Cookie[] } {
  const kept: Cookie[] = [];
  let bytes = 0;
  for (const cookie of cookies) {
    if (kept.length >= maxCookies) break;
    const size = JSON.stringify(cookie).length + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.push(cookie);
  }
  return { cookies: kept };
}
