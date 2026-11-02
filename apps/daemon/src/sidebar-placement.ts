import type { ThreadListEntry } from "@ace/protocol";
import { isChatEntry } from "@ace/ui-core/chat-list";
import {
  placeWithStanding,
  threadSignal,
  type PlaceInput,
  type PlacedStanding,
  type ThreadSignal,
} from "@ace/ui-core/thread-place";

/** How the Inbox orders unpinned threads (`threads.sortBy`). */
export type SidebarSort = NonNullable<PlaceInput["sortBy"]>;

/**
 * What the daemon places listed threads under (ADR 0107): the person's sort, the moment before
 * which finished work counts as seen, and this database's token. Together they are the list's
 * `epoch`: a list read under another epoch is placed differently, so it can't resume. A change
 * tells every sidebar subscription, which re-places what it holds.
 */
export class SidebarPlacement {
  private sortBy: SidebarSort = "activity";
  private baseline = 0;
  private readonly token: string;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  constructor(token: string, now: () => number) {
    this.token = token;
    this.now = now;
  }
  get epoch(): string {
    return `${this.token}:${this.sortBy}:${this.baseline}`;
  }
  /** The thread's place now with the standing it read, or undefined when the panel leaves it out. */
  place(entry: ThreadListEntry): PlacedStanding | undefined {
    return placeWithStanding(entry, {
      baseline: this.baseline,
      now: this.now(),
      sortBy: this.sortBy,
    });
  }
  setSort(sortBy: SidebarSort): void {
    if (sortBy === this.sortBy) return;
    this.sortBy = sortBy;
    this.emit();
  }
  setBaseline(baseline: number): void {
    if (baseline === this.baseline) return;
    this.baseline = baseline;
    this.emit();
  }
  /** Hear each change of what places threads. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One subscription's failure never stops the others re-placing.
      }
    }
  }
}

/** A listed entry as sent, with its place, and its part in the rail's dots. */
export interface Placed {
  entry: ThreadListEntry;
  signal: ThreadSignal | undefined;
}

/**
 * Entries with their places, worked out once per entry snapshot and epoch: entries are
 * replaced, never changed, so a list update places only the threads that changed.
 */
export class PlacedEntries {
  private known = new WeakMap<ThreadListEntry, Placed>();
  private epoch: string;
  private readonly placement: SidebarPlacement;
  constructor(placement: SidebarPlacement) {
    this.placement = placement;
    this.epoch = placement.epoch;
  }
  /** `entry` as the list sends it, with its place (none when the panel leaves it out). */
  placed(entry: ThreadListEntry): Placed {
    if (this.epoch !== this.placement.epoch) {
      this.known = new WeakMap();
      this.epoch = this.placement.epoch;
    }
    let placed = this.known.get(entry);
    if (!placed) {
      const found = this.placement.place(entry);
      const { place: _old, ...rest } = entry;
      placed = {
        entry: Object.freeze(found ? { ...rest, place: found.place } : rest),
        signal: found && threadSignal(found.place, found.standing, isChatEntry(entry)),
      };
      this.known.set(entry, placed);
    }
    return placed;
  }
}
