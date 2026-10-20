/** One console or network line of a fixture tab, shaped like the daemon's `logs` entries. */
export interface FakeLogEntry {
  kind: "console" | "network";
  type: string;
  text: string;
  tabId?: string;
  url?: string;
  status?: number;
  method?: string;
  bytes?: number;
  durationMs?: number;
}

/**
 * Each thread's browser log, as `BrowserCommand` `logs` reads it: the newest entries last,
 * filtered like the daemon's (`SessionLogs.read`). Tests script what a page logged.
 */
export class FakeBrowserLogs {
  private entries = new Map<string, (FakeLogEntry & { at: number })[]>();
  private now: () => number;
  constructor(now: () => number = () => 0) {
    this.now = now;
  }
  /** A page logged a line (or the browser saw a request). */
  add(threadId: string, entry: FakeLogEntry): void {
    const list = this.entries.get(threadId) ?? [];
    list.push({ ...entry, at: this.now() + list.length });
    if (list.length > 200) list.shift();
    this.entries.set(threadId, list);
  }
  read(
    threadId: string,
    filter: {
      tabId?: string | undefined;
      kind?: "console" | "network" | undefined;
      level?: string | undefined;
      limit: number;
    },
  ) {
    const entries = (this.entries.get(threadId) ?? [])
      .filter(
        (entry) =>
          (!filter.kind || entry.kind === filter.kind) &&
          (!filter.level || entry.type === filter.level) &&
          (!filter.tabId || !entry.tabId || entry.tabId === filter.tabId),
      )
      .slice(-filter.limit);
    return { entries, limit: filter.limit };
  }
}
