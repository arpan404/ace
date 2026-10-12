import type { TurnStep, TurnStepsResponse } from "@ace/protocol";
import type { ServiceRequest } from "./service-requests.ts";
import type { RequestOptions } from "./types.ts";

/*
 * Finished turns' steps, read on demand (`turn.steps`) when a "Worked for" log opens, held only
 * while something shows them. A turn on screen is retained; one released (collapsed, scrolled
 * far away, its thread closed) is dropped after a grace period, and the unretained ones together
 * never hold more than `maxSteps` steps. A turn read before it last changed (its `endSeq` moved
 * on) is read again.
 */

export interface TurnStepsEntry {
  state: "loading" | "ready" | "failed";
  steps: readonly TurnStep[];
  /** The turn's end when read; a summary past it means the turn changed since. */
  endSeq: number | undefined;
  /** The turn has more steps than one read holds. */
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
  /** Steps one turn's read stops at. */
  maxTurnSteps?: number;
  /** How long a released turn stays, in case it shows again. */
  graceMs?: number;
  schedule?(run: () => void, ms: number): () => void;
}

interface Slot {
  entry: TurnStepsEntry;
  holders: number;
  abort: AbortController | undefined;
  cancelExpiry: (() => void) | undefined;
}

const key = (threadId: string, ordinal: number) => `${threadId}\u0000${ordinal}`;
const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export class TurnStepsCache {
  private readonly slots = new Map<string, Slot>();
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
    let slot = this.slots.get(id);
    const stale =
      slot !== undefined &&
      slot.entry.state !== "loading" &&
      (slot.entry.state === "failed" ||
        (endSeq !== undefined && (slot.entry.endSeq ?? -1) < endSeq));
    if (!slot || stale) {
      slot?.abort?.abort();
      slot = {
        entry: { state: "loading", steps: slot?.entry.steps ?? [], endSeq: undefined, more: false },
        holders: slot?.holders ?? 0,
        abort: new AbortController(),
        cancelExpiry: slot?.cancelExpiry,
      };
      this.slots.set(id, slot);
      void this.load(id, threadId, ordinal, slot);
    }
    slot.holders++;
    slot.cancelExpiry?.();
    slot.cancelExpiry = undefined;
    let released = false;
    const held = slot;
    return () => {
      if (released) return;
      released = true;
      held.holders--;
      if (held.holders > 0 || this.slots.get(id) !== held) return;
      held.cancelExpiry = this.options.schedule(() => this.evict(id, held), this.options.graceMs);
      this.trim();
    };
  }

  /** The thread closed: none of its turns are needed. */
  dropThread(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const [id, slot] of this.slots)
      if (id.startsWith(prefix)) {
        slot.abort?.abort();
        slot.cancelExpiry?.();
        this.slots.delete(id);
      }
    this.emit();
  }

  private async load(id: string, threadId: string, ordinal: number, slot: Slot): Promise<void> {
    const steps: TurnStep[] = [];
    let after: number | undefined;
    let endSeq: number | undefined;
    let more = false;
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
        more = after !== undefined && steps.length >= this.options.maxTurnSteps;
      } while (after !== undefined && !more);
      if (this.slots.get(id) !== slot) return;
      slot.entry = { state: "ready", steps, endSeq, more };
    } catch {
      if (this.slots.get(id) !== slot || slot.abort?.signal.aborted) return;
      slot.entry = { ...slot.entry, state: "failed" };
    }
    slot.abort = undefined;
    this.trim();
    this.emit();
  }

  private evict(id: string, slot: Slot): void {
    if (this.slots.get(id) !== slot || slot.holders > 0) return;
    slot.abort?.abort();
    this.slots.delete(id);
    this.emit();
  }

  /** Oldest unretained turns go first until the rest fit. */
  private trim(): void {
    let total = 0;
    for (const slot of this.slots.values()) if (!slot.holders) total += slot.entry.steps.length;
    if (total <= this.options.maxSteps) return;
    for (const [id, slot] of this.slots) {
      if (total <= this.options.maxSteps) break;
      if (slot.holders) continue;
      total -= slot.entry.steps.length;
      slot.abort?.abort();
      slot.cancelExpiry?.();
      this.slots.delete(id);
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
