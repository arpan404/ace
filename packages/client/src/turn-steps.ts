import type { TurnStep, TurnStepsResponse } from "@ace/protocol";
import type { ServiceRequest } from "./service-requests.ts";
import type { RequestOptions } from "./types.ts";

/*
 * Finished turns' steps, read on demand (`turn.steps`) when a "Worked for" log opens, held only
 * while something shows them. A turn on screen is retained; one released (collapsed, scrolled
 * far away, its thread closed) is dropped after a grace period, and the unretained ones together
 * never hold more than `maxSteps` steps. A turn read before it last changed (its `endSeq` moved
 * on) is read again. A very long turn reads `maxTurnSteps` at a time; `loadMore` reads on.
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

export interface TurnStepsCacheOptions {
  read: Read;
  /** Steps the unretained turns may hold together. */
  maxSteps?: number;
  /** Steps one read of a turn stops at, until `loadMore`. */
  maxTurnSteps?: number;
  /** How long a released turn stays, in case it shows again. */
  graceMs?: number;
  schedule?(run: () => void, ms: number): () => void;
}

interface Slot {
  entry: TurnStepsEntry;
  /** Where the next read continues, when the turn has more. */
  cursor: number | undefined;
  abort: AbortController | undefined;
}

const key = (threadId: string, ordinal: number) => `${threadId}\u0000${ordinal}`;
const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export class TurnStepsCache {
  private readonly slots = new Map<string, Slot>();
  /** Holds by turn, apart from slots: a turn read again keeps the holds it had. */
  private readonly holds = new Map<string, number>();
  private readonly expiries = new Map<string, () => void>();
  /** Bumped when a thread is dropped, so holds taken before it release nothing after. */
  private readonly epochs = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly options: Required<Omit<TurnStepsCacheOptions, "read">> & { read: Read };
  constructor(options: TurnStepsCacheOptions) {
    this.options = {
      maxSteps: 2000,
      maxTurnSteps: 1000,
      graceMs: 30_000,
      schedule: defaultSchedule,
      ...options,
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
    const stale =
      slot !== undefined &&
      slot.entry.state !== "loading" &&
      (slot.entry.state === "failed" ||
        (endSeq !== undefined && (slot.entry.endSeq ?? -1) < endSeq));
    if (!slot || stale) this.read(id, threadId, ordinal, slot?.entry.steps ?? []);
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    this.expiries.get(id)?.();
    this.expiries.delete(id);
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
      this.expiries.set(
        id,
        this.options.schedule(() => this.evict(id), this.options.graceMs),
      );
      this.trim();
    };
  }

  /** Read the next part of a turn that has more than one read holds. */
  loadMore(threadId: string, ordinal: number): void {
    const id = key(threadId, ordinal);
    const slot = this.slots.get(id);
    if (!slot || slot.entry.state !== "ready" || !slot.entry.more) return;
    slot.entry = { ...slot.entry, state: "loading" };
    slot.abort = new AbortController();
    this.emit();
    void this.load(id, threadId, ordinal, slot, [...slot.entry.steps], slot.cursor);
  }

  /** The thread closed: none of its turns are needed. */
  dropThread(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    this.epochs.set(threadId, (this.epochs.get(threadId) ?? 0) + 1);
    for (const [id, slot] of this.slots)
      if (id.startsWith(prefix)) {
        slot.abort?.abort();
        this.slots.delete(id);
      }
    for (const [id, cancel] of this.expiries)
      if (id.startsWith(prefix)) {
        cancel();
        this.expiries.delete(id);
      }
    for (const id of this.holds.keys()) if (id.startsWith(prefix)) this.holds.delete(id);
    this.emit();
  }

  private read(id: string, threadId: string, ordinal: number, shown: readonly TurnStep[]): void {
    this.slots.get(id)?.abort?.abort();
    const slot: Slot = {
      entry: { state: "loading", steps: shown, endSeq: undefined, more: false },
      cursor: undefined,
      abort: new AbortController(),
    };
    this.slots.set(id, slot);
    void this.load(id, threadId, ordinal, slot, [], undefined);
  }

  private async load(
    id: string,
    threadId: string,
    ordinal: number,
    slot: Slot,
    steps: TurnStep[],
    from: number | undefined,
  ): Promise<void> {
    let after = from;
    let endSeq = slot.entry.endSeq;
    const stop = steps.length + this.options.maxTurnSteps;
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
          slot.abort ? { signal: slot.abort.signal } : {},
        );
        endSeq = page.endSeq;
        steps.push(...page.steps);
        after = page.after ?? undefined;
      } while (after !== undefined && steps.length < stop);
      if (this.slots.get(id) !== slot) return;
      slot.entry = { state: "ready", steps, endSeq, more: after !== undefined };
      slot.cursor = after;
    } catch {
      if (this.slots.get(id) !== slot || slot.abort?.signal.aborted) return;
      slot.entry = { ...slot.entry, state: "failed" };
    }
    slot.abort = undefined;
    this.trim();
    this.emit();
  }

  private evict(id: string): void {
    this.expiries.delete(id);
    if (this.holds.get(id)) return;
    this.slots.get(id)?.abort?.abort();
    if (this.slots.delete(id)) this.emit();
  }

  /** Oldest unretained turns go first until the rest fit. */
  private trim(): void {
    let total = 0;
    for (const [id, slot] of this.slots) if (!this.holds.get(id)) total += slot.entry.steps.length;
    if (total <= this.options.maxSteps) return;
    for (const [id, slot] of this.slots) {
      if (total <= this.options.maxSteps) break;
      if (this.holds.get(id)) continue;
      total -= slot.entry.steps.length;
      slot.abort?.abort();
      this.expiries.get(id)?.();
      this.expiries.delete(id);
      this.slots.delete(id);
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
