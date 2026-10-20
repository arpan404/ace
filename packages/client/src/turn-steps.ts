import type { TurnStep, TurnStepsResponse } from "@ace/protocol";
import type { ServiceRequest } from "./service-requests.ts";
import type { RequestOptions } from "./types.ts";
import type { TurnStepsRecord } from "./turn-steps-record.ts";

/*
 * Finished turns' steps, read on demand (`turn.steps`) when a "Worked for" log opens or is about
 * to. A turn on screen is retained; a read turn stays after it is released (collapsed, scrolled
 * away, its thread closed) so it shows again at once, until the unretained turns together pass
 * `maxSteps` steps or `maxTurns` turns, oldest use first. A turn read before it last changed (its
 * `endSeq` moved on) is read again. A very long turn reads `maxTurnSteps` at a time; `loadMore`
 * reads on.
 *
 * With a `store`, every finished read is kept between sessions, and a turn not in memory looks
 * there while the daemon reads it: a record at least as new as the turn's summary shows at once
 * (and ends the read when it is complete); an older one shows until the daemon's read replaces it.
 */

export interface TurnStepsEntry {
  state: "loading" | "ready" | "failed";
  steps: readonly TurnStep[];
  /** The turn's end when read; a summary past it means the turn changed since. */
  endSeq: number | undefined;
  /** The turn has more steps than have been read; `loadMore` reads the next part. */
  more: boolean;
}

type Read = (
  input: Extract<ServiceRequest, { type: "turn.steps" }>,
  options: RequestOptions,
) => Promise<TurnStepsResponse>;

/** Where finished reads are kept between sessions. What `get` returns is untrusted. */
export interface TurnStepsStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface TurnStepsCacheOptions {
  read: Read;
  store?: TurnStepsStore | undefined;
  /** Steps the unretained turns may hold together. */
  maxSteps?: number;
  /** Unretained turns kept at most. */
  maxTurns?: number;
  /** Steps one read of a turn stops at, until `loadMore`. */
  maxTurnSteps?: number;
  /** How long `warm` holds a turn that is about to open. */
  warmMs?: number;
  schedule?(run: () => void, ms: number): () => void;
}

interface Slot {
  entry: TurnStepsEntry;
  /** Where the next read continues, when the turn has more. */
  cursor: number | undefined;
  /** The read in flight. */
  abort: AbortController | undefined;
  /** What the turn held before the read in flight (`loadMore`), should that read be ended. */
  resume: TurnStepsEntry | undefined;
  /** The newest end of the turn its summaries named while it was read. */
  known: number | undefined;
}

const key = (threadId: string, ordinal: number) => `${threadId}\u0000${ordinal}`;
const storeKey = (threadId: string, ordinal: number) => `${threadId}/${ordinal}`;
const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};
const ignore = () => {};

export class TurnStepsCache {
  private readonly slots = new Map<string, Slot>();
  /** Holds by turn, apart from slots: a turn read again keeps the holds it had. */
  private readonly holds = new Map<string, number>();
  /** Turns held by `warm` until it lets go. */
  private readonly warming = new Set<string>();
  /** Bumped when a thread is dropped, so holds taken before it release nothing after. */
  private readonly epochs = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly options: Required<Omit<TurnStepsCacheOptions, "read" | "store">> & {
    read: Read;
    store: TurnStepsStore | undefined;
  };
  constructor(options: TurnStepsCacheOptions) {
    this.options = {
      maxSteps: 2000,
      maxTurns: 100,
      maxTurnSteps: 1000,
      warmMs: 10_000,
      schedule: defaultSchedule,
      ...options,
      store: options.store,
    };
  }

  get(threadId: string, ordinal: number): TurnStepsEntry | undefined {
    const id = key(threadId, ordinal);
    const slot = this.slots.get(id);
    if (!slot) return undefined;
    // Reading refreshes its place among the unretained.
    this.slots.delete(id);
    this.slots.set(id, slot);
    return slot.entry;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Keep the turn while it shows, reading it when it is not held or `endSeq` (from its summary)
   * says it changed since. Returns the release.
   */
  retain(threadId: string, ordinal: number, endSeq?: number): () => void {
    const id = key(threadId, ordinal);
    const slot = this.slots.get(id);
    if (!slot) this.read(id, threadId, ordinal, endSeq, []);
    else if (slot.entry.state === "loading") {
      if (endSeq !== undefined) slot.known = Math.max(slot.known ?? endSeq, endSeq);
    } else if (
      slot.entry.state === "failed" ||
      (endSeq !== undefined && (slot.entry.endSeq ?? -1) < endSeq)
    )
      this.read(id, threadId, ordinal, endSeq, slot.entry.steps);
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    let released = false;
    const epoch = this.epochs.get(threadId) ?? 0;
    return () => {
      // A hold from before the thread was dropped has nothing left to release.
      if (released || (this.epochs.get(threadId) ?? 0) !== epoch) return;
      released = true;
      const left = (this.holds.get(id) ?? 1) - 1;
      if (left > 0) {
        this.holds.set(id, left);
        return;
      }
      this.holds.delete(id);
      this.trim();
    };
  }

  /** The turn is about to open (pointer over it, focus on it): read it now, hold it a while. */
  warm(threadId: string, ordinal: number, endSeq?: number): void {
    const id = key(threadId, ordinal);
    if (this.warming.has(id)) return;
    this.warming.add(id);
    const release = this.retain(threadId, ordinal, endSeq);
    this.options.schedule(() => {
      this.warming.delete(id);
      release();
    }, this.options.warmMs);
  }

  /** Read the next part of a turn that has more than one read holds. */
  loadMore(threadId: string, ordinal: number): void {
    const id = key(threadId, ordinal);
    const slot = this.slots.get(id);
    if (!slot || slot.entry.state !== "ready" || !slot.entry.more) return;
    const controller = new AbortController();
    slot.resume = slot.entry;
    slot.entry = { ...slot.entry, state: "loading" };
    slot.abort = controller;
    this.emit();
    void this.load(id, threadId, ordinal, slot, controller, [...slot.entry.steps], slot.cursor);
  }

  /**
   * The thread's view closed: nothing holds its turns any more and their reads in flight end.
   * What was read stays, within the budget, for when the thread opens again.
   */
  dropThread(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    this.epochs.set(threadId, (this.epochs.get(threadId) ?? 0) + 1);
    for (const id of this.holds.keys()) if (id.startsWith(prefix)) this.holds.delete(id);
    for (const id of this.warming) if (id.startsWith(prefix)) this.warming.delete(id);
    for (const [id, slot] of this.slots) {
      if (!id.startsWith(prefix) || !slot.abort) continue;
      slot.abort.abort();
      slot.abort = undefined;
      if (!slot.resume) {
        this.slots.delete(id);
        continue;
      }
      slot.entry = slot.resume;
      slot.resume = undefined;
    }
    this.trim();
    this.emit();
  }

  private read(
    id: string,
    threadId: string,
    ordinal: number,
    endSeq: number | undefined,
    shown: readonly TurnStep[],
  ): void {
    const before = this.slots.get(id);
    before?.abort?.abort();
    const controller = new AbortController();
    const slot: Slot = {
      entry: { state: "loading", steps: shown, endSeq: undefined, more: false },
      cursor: undefined,
      abort: controller,
      resume: undefined,
      known: endSeq,
    };
    this.slots.set(id, slot);
    if (!before) void this.recall(id, threadId, ordinal, slot, controller);
    void this.load(id, threadId, ordinal, slot, controller, [], undefined);
  }

  /** Show the turn's stored record while the daemon reads it, if the store answers first. */
  private async recall(
    id: string,
    threadId: string,
    ordinal: number,
    slot: Slot,
    controller: AbortController,
  ): Promise<void> {
    const store = this.options.store;
    if (!store) return;
    let record: TurnStepsRecord | undefined;
    try {
      // The record's schema loads with the first record: none of it is on the first screen.
      const [value, { parseTurnStepsRecord }] = await Promise.all([
        store.get(storeKey(threadId, ordinal)),
        import("./turn-steps-record.ts"),
      ]);
      record = parseTurnStepsRecord(value, threadId, ordinal);
    } catch {
      return;
    }
    // The daemon answered first, or the read was ended: what it holds now is newer.
    if (this.slots.get(id) !== slot || slot.abort !== controller) return;
    if (!record) return;
    const current = slot.known === undefined || record.endSeq >= slot.known;
    if (current && !record.more) {
      controller.abort();
      slot.abort = undefined;
      slot.entry = { state: "ready", steps: record.steps, endSeq: record.endSeq, more: false };
    } else {
      // Older than the turn now, or only its first part: shown until the daemon's read lands.
      slot.entry = { ...slot.entry, steps: record.steps };
    }
    this.trim();
    this.emit();
  }

  private async load(
    id: string,
    threadId: string,
    ordinal: number,
    slot: Slot,
    controller: AbortController,
    steps: TurnStep[],
    from: number | undefined,
  ): Promise<void> {
    let after = from;
    let endSeq = slot.entry.endSeq;
    const stop = steps.length + this.options.maxTurnSteps;
    const ended = () => controller.signal.aborted || this.slots.get(id) !== slot;
    try {
      do {
        const page = await this.options.read(
          {
            type: "turn.steps",
            threadId,
            turnOrdinal: ordinal,
            limit: 200,
            ...(after === undefined ? {} : { after }),
          },
          { signal: controller.signal },
        );
        if (ended()) return;
        endSeq = page.endSeq;
        steps.push(...page.steps);
        after = page.after ?? undefined;
      } while (after !== undefined && steps.length < stop);
      const more = after !== undefined;
      slot.entry = { state: "ready", steps, endSeq, more };
      slot.cursor = after;
      this.keep(threadId, ordinal, { endSeq, more, cursor: after, steps });
    } catch {
      if (ended()) return;
      slot.entry = { ...slot.entry, state: "failed" };
    }
    slot.abort = undefined;
    slot.resume = undefined;
    this.trim();
    this.emit();
  }

  /** File a finished read in the store. A failed one never is. */
  private keep(
    threadId: string,
    ordinal: number,
    read: {
      endSeq: number | undefined;
      more: boolean;
      cursor: number | undefined;
      steps: TurnStep[];
    },
  ): void {
    const store = this.options.store;
    if (!store || read.endSeq === undefined) return;
    const record: TurnStepsRecord = {
      version: 1,
      threadId,
      ordinal,
      endSeq: read.endSeq,
      more: read.more,
      cursor: read.cursor ?? null,
      steps: read.steps,
    };
    try {
      void store.set(storeKey(threadId, ordinal), record).catch(ignore);
    } catch {
      // An optional cache: a write that fails is a miss next time.
    }
  }

  /** Oldest unretained turns go first until the rest fit. */
  private trim(): void {
    let steps = 0;
    let turns = 0;
    for (const [id, slot] of this.slots)
      if (!this.holds.get(id)) {
        steps += slot.entry.steps.length;
        turns++;
      }
    if (steps <= this.options.maxSteps && turns <= this.options.maxTurns) return;
    for (const [id, slot] of this.slots) {
      if (steps <= this.options.maxSteps && turns <= this.options.maxTurns) break;
      if (this.holds.get(id)) continue;
      steps -= slot.entry.steps.length;
      turns--;
      slot.abort?.abort();
      this.slots.delete(id);
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
