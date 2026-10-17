import type { BrowserCdp } from "./backend.ts";

/**
 * Clears what ace's Chrome keeps for the person: every cookie and the HTTP cache of the tab's
 * browser context, and site storage (local and session storage, IndexedDB, cache storage,
 * service workers) of each origin given. Chrome has no CDP call that lists every origin with
 * stored data, so storage is cleared for the origins the thread's tabs show; cookies and the
 * cache go for the whole context.
 */
export async function clearHeadlessData(cdp: BrowserCdp, origins: readonly string[]) {
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Network.clearBrowserCache");
  for (const origin of origins)
    await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
}
