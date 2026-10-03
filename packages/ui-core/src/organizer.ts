import { z } from "zod";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/*
 * How this device shows the Home list. Settle, snooze, pin, read state, titles and deletion
 * belong to the daemon (ADR 0057) and arrive on each thread list entry; what stays here is
 * view state: the unread baseline of a first launch, the project filter, whether Settled is
 * open, and threads hidden while their archive or delete waits out its undo window.
 */

/** The daemon's auto-settle window (`threads.autoSettleAfter`). */
export const AutoSettle = z.enum(["1d", "2d", "1w", "never"]);
export type AutoSettle = z.infer<typeof AutoSettle>;

const Stored = z.object({
  /** Activity before this moment counts as seen, so a first launch isn't all unread. */
  baseline: z.number(),
  /** Home list project filter; null is every project. */
  project: z.string().nullable().catch(null),
  settledOpen: z.boolean().catch(false),
});
type Stored = z.infer<typeof Stored>;

export interface OrganizerState extends Stored {
  /** Threads hidden while their archive or delete waits out its undo window. Not persisted. */
  hiding: ReadonlySet<string>;
}

const storageKey = "ace.home.organizer";

/** A small external store: React reads it with `useSyncExternalStore`. */
export class Organizer {
  private state: OrganizerState;
  private listeners = new Set<() => void>();
  private storage: KeyValueStorage | undefined;
  constructor(storage: KeyValueStorage | undefined, now: number) {
    this.storage = storage;
    const fresh: Stored = { baseline: now, project: null, settledOpen: false };
    const stored = readJson(storage, storageKey, Stored, fresh);
    this.state = { ...stored, hiding: new Set() };
    if (stored === fresh) this.persist();
  }
  getState = (): OrganizerState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setProject(project: string | null): void {
    this.set({ project });
  }
  setSettledOpen(settledOpen: boolean): void {
    this.set({ settledOpen });
  }
  setHiding(threadId: string, hidden: boolean): void {
    const hiding = new Set(this.state.hiding);
    if (hidden) hiding.add(threadId);
    else hiding.delete(threadId);
    this.state = { ...this.state, hiding };
    this.emit();
  }
  private set(patch: Partial<Stored>): void {
    this.state = { ...this.state, ...patch };
    this.persist();
    this.emit();
  }
  private persist(): void {
    const { baseline, project, settledOpen } = this.state;
    writeJson(this.storage, storageKey, { baseline, project, settledOpen } satisfies Stored);
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
