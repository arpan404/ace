import { BrowserActionError } from "./action-error.ts";
import { agentInputDelay, type CollaborationTiming } from "./collaboration.ts";
import type { NavigationClock } from "./navigation.ts";

/** What a lane step returns when the person became busy again before it could run. */
export const personReturned: unique symbol = Symbol("personReturned");
export type LaneStep<T> = () => Promise<T | typeof personReturned>;

/** Agent inputs one tab holds waiting for the person, beyond what its queue holds. */
const laneLimit = 32;

/**
 * One tab's agent inputs that wait for the person (ADR 0067, "Collaboration"). They run in the
 * order they came, and they wait here, outside the tab's command queue, so an agent's reads
 * (snapshot, screenshot, find, logs) never queue behind an input that waits for the person.
 * Each step is handed to the queue only once the person paused; a step that finds them busy
 * again when its turn comes returns `personReturned` and waits here once more, all within one
 * `maxWaitMs` budget counted from when the input arrived.
 */
export class AgentInputLane {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private wakers = new Set<() => void>();
  private closed = false;
  private readonly clock: NavigationClock;
  private readonly timing: CollaborationTiming;
  private readonly humanAt: () => number;
  constructor(clock: NavigationClock, timing: CollaborationTiming, humanAt: () => number) {
    this.clock = clock;
    this.timing = timing;
    this.humanAt = humanAt;
  }
  get idle(): boolean {
    return this.pending === 0;
  }
  settled(): Promise<unknown> {
    return this.tail;
  }
  /** Ends every wait: the tab or its browser closed. */
  close(): void {
    this.closed = true;
    for (const wake of this.wakers) wake();
  }
  /** Runs `steps` in order, after earlier inputs, each once the person has paused. */
  run<T>(signal: AbortSignal | undefined, steps: (step: Stepper) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserActionError("browser_closed"));
    if (this.pending >= laneLimit) return Promise.reject(new BrowserActionError("queue_full"));
    this.pending++;
    const since = this.clock.now();
    const stepper: Stepper = async (step) => {
      for (;;) {
        await this.personIdle(since, signal);
        const result = await step();
        if (result !== personReturned) return result;
      }
    };
    const result = this.tail.then(() => steps(stepper));
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return result;
  }
  /** The person has paused: a step whose turn came may run; otherwise it hands its turn back. */
  quiet(): boolean {
    return this.humanAt() + this.timing.quietMs <= this.clock.now();
  }
  private async personIdle(since: number, signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.closed) throw new BrowserActionError("browser_closed");
      const delay = agentInputDelay(this.clock.now(), this.humanAt(), since, this.timing);
      if (delay === "give_up") throw new BrowserActionError("human_active");
      if (delay === 0) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          cancel();
          signal?.removeEventListener("abort", finish);
          this.wakers.delete(finish);
          resolve();
        };
        const cancel = this.clock.set(delay, finish);
        signal?.addEventListener("abort", finish, { once: true });
        this.wakers.add(finish);
      });
    }
  }
}

/** Runs one step of a lane input once the person has paused, retrying if they come back. */
export type Stepper = <T>(step: LaneStep<T>) => Promise<T>;
