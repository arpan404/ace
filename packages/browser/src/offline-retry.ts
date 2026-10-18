import type { NavigationClock } from "./navigation.ts";

/** Load failures that mean the machine lost its connection, not that the site is down. */
const offline = /net::(ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED)\b/;
export function offlineFailure(loadError: string | undefined): boolean {
  return loadError !== undefined && offline.test(loadError);
}
const firstMs = 2_000;
const longestMs = 30_000;

/**
 * Reloads tabs whose page failed because the machine was offline, until the connection is
 * back: after 2 s, then twice as long each time, at most every 30 s. A tab that loads, leaves
 * the error or closes stops being retried.
 */
export class OfflineRetries {
  private tabs = new Map<string, { attempt: number; cancel?: (() => void) | undefined }>();
  private clock: NavigationClock;
  private reload: (tabId: string) => Promise<void>;
  private closed = false;
  constructor(clock: NavigationClock, reload: (tabId: string) => Promise<void>) {
    this.clock = clock;
    this.reload = reload;
  }
  /** Every tab's load state, after any change. */
  update(tabs: readonly { tabId: string; loading: boolean; loadError?: string | undefined }[]) {
    if (this.closed) return;
    const seen = new Set<string>();
    for (const tab of tabs) {
      seen.add(tab.tabId);
      const retry = this.tabs.get(tab.tabId);
      if (!offlineFailure(tab.loadError)) {
        // Still loading a retry: keep counting; anything else ends the retries.
        if (retry && !tab.loading) this.stop(tab.tabId);
        continue;
      }
      if (tab.loading || retry?.cancel) continue;
      const attempt = retry?.attempt ?? 0;
      const entry = { attempt: attempt + 1, cancel: undefined as (() => void) | undefined };
      entry.cancel = this.clock.set(Math.min(longestMs, firstMs * 2 ** attempt), () => {
        entry.cancel = undefined;
        if (!this.closed) void this.reload(tab.tabId).catch(() => {});
      });
      this.tabs.set(tab.tabId, entry);
    }
    for (const tabId of this.tabs.keys()) if (!seen.has(tabId)) this.stop(tabId);
  }
  close(): void {
    this.closed = true;
    for (const tabId of this.tabs.keys()) this.stop(tabId);
  }
  private stop(tabId: string): void {
    this.tabs.get(tabId)?.cancel?.();
    this.tabs.delete(tabId);
  }
}
