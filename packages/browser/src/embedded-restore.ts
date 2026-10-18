import type { BackendRestoreTab } from "./backend.ts";
import { navigateCdp } from "./cdp-navigation.ts";
import type { EmbeddedTabs } from "./embedded-tabs.ts";
import type { NavigationClock } from "./navigation.ts";

/** How long a restored tab gets to load its address; a slow page is left as it is. */
const reopenMs = 30_000;

/**
 * Brings a thread's tabs back in the desktop's fresh views (after an app restart, or when the
 * desktop came back without the views it kept): the same ids, in order, each at its address,
 * the first shown. The view the desktop opened blank gives way to them. A desktop that cannot
 * choose ids or hold more tabs keeps what it has; nothing here fails the open.
 */
export async function restoreEmbeddedTabs(
  tabs: EmbeddedTabs,
  entries: readonly BackendRestoreTab[],
  signal: AbortSignal,
  clock: NavigationClock,
): Promise<void> {
  const blank = tabs.active();
  const opened: BackendRestoreTab[] = [];
  /** The blank view already has a restored tab's id (both are the desktop's first): reuse it. */
  const reused = entries.some((entry) => entry.tabId === blank);
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.tabId === blank) {
      opened.push(entry);
      continue;
    }
    let tabId: string;
    try {
      tabId = await tabs.open({
        background: opened.length > 0 || reused,
        tabId: entry.tabId,
      });
    } catch {
      break;
    }
    // A desktop holding one tab hands back the one it has.
    if (tabId === blank || opened.some((tab) => tab.tabId === tabId)) break;
    opened.push({ tabId, url: entry.url });
    if (!reused && opened.length === 1 && blank) await tabs.close(blank).catch(() => {});
  }
  const first = entries[0];
  if (!opened.length && blank && first) opened.push({ tabId: blank, url: first.url });
  await Promise.allSettled(
    opened.map(async ({ tabId, url }) => {
      if (url === "about:blank") return;
      const deadline = new AbortController();
      const cancel = clock.set(reopenMs, () =>
        deadline.abort(new Error("The page did not reopen in time")),
      );
      try {
        await navigateCdp(tabs.tab(tabId).cdp, url, AbortSignal.any([signal, deadline.signal]));
      } finally {
        cancel();
      }
    }),
  );
}
