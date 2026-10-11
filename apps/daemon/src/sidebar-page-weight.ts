import type { ThreadListEntry, ThreadListWindow } from "@ace/protocol";

/** Retained entries are immutable snapshots. Weak keys release weights with their owners. */
export class SidebarPageWeight {
  private readonly entries = new WeakMap<ThreadListEntry, number>();

  bytes(page: { threads: ThreadListEntry[]; window: ThreadListWindow }): number {
    // The empty array already includes both brackets; only elements and commas remain.
    let bytes = Buffer.byteLength(JSON.stringify({ threads: [], window: page.window }));
    for (const entry of page.threads) {
      let weight = this.entries.get(entry);
      if (weight === undefined) {
        weight = Buffer.byteLength(JSON.stringify(entry));
        this.entries.set(entry, weight);
      }
      bytes += weight;
    }
    return bytes + Math.max(0, page.threads.length - 1);
  }
}
