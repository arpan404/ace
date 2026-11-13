/*
 * The person's presence on a surface (ADR 0143, cowork): a browser tab, a screen app, a
 * simulator. Each input of the person's extends a lease on that surface for `personQuietMs`; an
 * agent's action there waits until the lease lapses, for at most `personWaitMs`, then gives up
 * without running. Reads never ask. Pure but for the clock and timers it is given.
 */

/** The person counts as using a surface for this long after their last input there. */
export const personQuietMs = 3_000;
/** The longest an agent's action waits for the person before it gives up (`person_busy`). */
export const personWaitMs = 60_000;

export interface PresenceTiming {
  quietMs: number;
  maxWaitMs: number;
}

export const presenceTiming: PresenceTiming = { quietMs: personQuietMs, maxWaitMs: personWaitMs };

/**
 * What an agent's action waiting since `since` does now, given the person's last input at
 * `personAt`: run, wait `ms` more (until the lease lapses or the wait runs out), or give up.
 */
export type PresenceStep = { kind: "run" } | { kind: "wait"; ms: number } | { kind: "give_up" };

export function presenceStep(
  now: number,
  personAt: number,
  since: number,
  timing: PresenceTiming = presenceTiming,
): PresenceStep {
  const lapsesIn = personAt + timing.quietMs - now;
  if (lapsesIn <= 0) return { kind: "run" };
  const left = since + timing.maxWaitMs - now;
  if (left <= 0) return { kind: "give_up" };
  return { kind: "wait", ms: Math.min(lapsesIn, left) };
}

/** Whether the person's lease is active at `now`. */
export function personActive(
  now: number,
  personAt: number,
  timing: PresenceTiming = presenceTiming,
): boolean {
  return now - personAt < timing.quietMs;
}

/**
 * The line a waited action's result carries, or undefined when it barely waited (under half a
 * second). `where` names the surface: "this tab", "Safari", "the iPhone 17".
 */
export function waitedNote(waitedMs: number, where: string): string | undefined {
  if (waitedMs < 500) return undefined;
  const seconds = Math.max(1, Math.round(waitedMs / 1000));
  return `Waited ${seconds} s while the person used ${where}.`;
}

export interface PresenceClock {
  now(): number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  set(ms: number, run: () => void): () => void;
}

export interface PersonPresenceOptions {
  clock: PresenceClock;
  timing?: PresenceTiming;
  /** Told when a surface's lease starts or lapses, so streams can carry `personActive`. */
  changed?(surface: string, active: boolean): void;
  /**
   * The person's last input on `surface` that ace does not route (physical keyboard and mouse
   * while that app is frontmost), in clock ms; undefined when unknown or none. Asked when an
   * action is about to run and when a lease lapses, never on a timer of its own.
   */
  sample?(surface: string): Promise<number | undefined>;
}

/** The result of waiting for the person: ran after `waitedMs`, or gave up (`busy`). */
export type PresenceYield = { busy: false; waitedMs: number } | { busy: true; waitedMs: number };

/**
 * Every surface's lease, and the agent actions waiting on them. Waits are event-driven: a waiter
 * sleeps until its surface's lease lapses (or its wait runs out), then looks again.
 */
export class PersonPresence {
  private readonly clock: PresenceClock;
  private readonly timing: PresenceTiming;
  private readonly options: PersonPresenceOptions;
  private readonly lastInput = new Map<string, number>();
  private readonly lapses = new Map<string, () => void>();
  constructor(options: PersonPresenceOptions) {
    this.options = options;
    this.clock = options.clock;
    this.timing = options.timing ?? presenceTiming;
  }

  /** The person acted on `surface` at `at` (now by default): their lease runs from then. */
  input(surface: string, at = this.clock.now()): void {
    const before = this.lastInput.get(surface);
    if (before !== undefined && before >= at) return;
    const wasActive = this.active(surface);
    this.lastInput.set(surface, at);
    if (!this.active(surface)) return;
    this.lapses.get(surface)?.();
    const cancel = this.clock.set(at + this.timing.quietMs - this.clock.now(), () => {
      if (this.lapses.get(surface) !== cancel) return;
      this.lapses.delete(surface);
      const publish = () => {
        if (!this.active(surface)) this.options.changed?.(surface, false);
      };
      if (this.options.sample) void this.refresh(surface).then(publish);
      else publish();
    });
    this.lapses.set(surface, cancel);
    if (!wasActive) this.options.changed?.(surface, true);
  }

  /** The person used `surface` within the quiet window. */
  active(surface: string): boolean {
    const at = this.lastInput.get(surface);
    return at !== undefined && personActive(this.clock.now(), at, this.timing);
  }

  /** The surfaces whose lease is active now. */
  activeSurfaces(): string[] {
    return [...this.lastInput.keys()].filter((surface) => this.active(surface));
  }

  /**
   * Waits until the person's lease on `surface` lapses, at most `maxWaitMs` from now. An abort
   * rejects with the signal's reason. Physical input (`sample`) is looked at before the first
   * decision and each time the lease would lapse.
   */
  async yield(surface: string, signal?: AbortSignal): Promise<PresenceYield> {
    const since = this.clock.now();
    for (;;) {
      signal?.throwIfAborted();
      await this.refresh(surface);
      signal?.throwIfAborted();
      const now = this.clock.now();
      const step = presenceStep(now, this.lastInput.get(surface) ?? -Infinity, since, this.timing);
      if (step.kind === "run") return { busy: false, waitedMs: now - since };
      if (step.kind === "give_up") return { busy: true, waitedMs: now - since };
      await this.sleep(step.ms, signal);
    }
  }

  /** Forgets a surface that closed, so it holds nothing. */
  forget(surface: string): void {
    const wasActive = this.active(surface);
    this.lapses.get(surface)?.();
    this.lapses.delete(surface);
    this.lastInput.delete(surface);
    if (wasActive) this.options.changed?.(surface, false);
  }

  private async refresh(surface: string): Promise<void> {
    if (!this.options.sample) return;
    let at: number | undefined;
    try {
      at = await this.options.sample(surface);
    } catch {
      // An unreadable idle source counts as no physical input: ace-routed input still holds.
      return;
    }
    if (at !== undefined) this.input(surface, at);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        cancel();
        reject(signal?.reason);
      };
      const cancel = this.clock.set(ms, () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
