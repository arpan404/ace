import type { BrowserTabActor } from "@ace/protocol";

/** What the daemon keeps about a tab so a restarted daemon can bring it back. */
export interface BrowserTabRecord {
  tabId: string;
  position: number;
  url: string;
  title: string;
  label?: string | undefined;
  openedBy?: BrowserTabActor | undefined;
  /** The person keeps agents out of this tab; it stays so after a restart. */
  private?: boolean | undefined;
  /** An agent kept it as a deliverable or handoff: it outlives the agent's turn. */
  kept?: boolean | undefined;
  lastActiveAt: number;
}
/**
 * Persistence for thread tabs, injected by the daemon (SQLite there, memory in tests). Writes
 * replace a thread's whole list; a closed browser clears it.
 */
export interface BrowserTabStore {
  load(threadId: string): BrowserTabRecord[];
  save(threadId: string, tabs: readonly BrowserTabRecord[]): void;
  clear(threadId: string): void;
}

/**
 * A fork's copy of its parent's tabs: addresses, titles and labels under new ids, in order.
 * Pure. Tabs the person keeps agents out of stay behind, and copies belong to no agent.
 */
export function forkTabRecords(
  parent: readonly BrowserTabRecord[],
  newId: () => string,
  now: number,
): BrowserTabRecord[] {
  return parent
    .filter((tab) => !tab.private)
    .toSorted((a, b) => a.position - b.position)
    .map((tab, position) => {
      const copy: BrowserTabRecord = {
        tabId: newId(),
        position,
        url: tab.url,
        title: tab.title,
        lastActiveAt: now,
      };
      if (tab.label) copy.label = tab.label;
      return copy;
    });
}
