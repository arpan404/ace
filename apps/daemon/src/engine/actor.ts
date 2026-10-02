import { nextDeadline, type Fact } from "@ace/core";
import type { Frame, ProviderSession, Translator } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

export interface EngineClock {
  now(): number;
  setTimer(callback: () => void, delay: number): () => void;
}
export const systemClock: EngineClock = {
  now: Date.now,
  setTimer(callback, delay) {
    const timer = setTimeout(callback, Math.min(delay, 2_147_483_647));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Frame folding never waits for provider I/O. One mailbox orders frames and ticks. */
export class ThreadActor {
  readonly id: ThreadId;
  translator?: Translator;
  session?: ProviderSession;
  lifetime?: AbortController;
  generation = 0;
  poisoned = false;
  dispatched = false;
  idleSince?: number;
  idleDue = false;
  private tail: Promise<void> = Promise.resolve();
  private cancelTimer?: () => void;
  private stopped = false;
  private repo: EngineRepository;
  private clock: EngineClock;
  private idleMs: number;
  private wake: () => void;
  private report: (error: unknown) => void;
  constructor(id: ThreadId, repo: EngineRepository, clock: EngineClock, idleMs: number,
    wake: () => void, report: (error: unknown) => void) {
    this.id = id; this.repo = repo; this.clock = clock; this.idleMs = idleMs;
    this.wake = wake; this.report = report;
  }
  enqueue(run: () => void): void {
    this.tail = this.tail.then(() => {
      if (!this.stopped && !this.poisoned) run();
    }).catch((error: unknown) => {
      // A translator cannot roll back. Stop this generation instead of folding more frames.
      this.poisoned = true;
      this.lifetime?.abort();
      this.report(error);
      this.wake();
    });
  }
  frame(frame: Frame, generation: number): void {
    this.enqueue(() => {
      if (generation !== this.generation) return;
      const facts = this.translator?.translate(frame, this.clock.now()) ?? [];
      this.apply(facts);
      if (facts.some((fact) => fact.type === "turn.ended" || fact.type === "process.exited"))
        this.dispatched = false;
      this.wake();
    });
  }
  apply(facts: Fact[]): void {
    this.repo.apply(this.id, facts, this.clock.now());
    this.schedule();
  }
  schedule(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.stopped || this.poisoned) return;
    const state = this.repo.state(this.id);
    if (!state) return;
    if (state.status.state === "done" && this.session && !this.dispatched) {
      this.idleSince ??= this.clock.now();
    } else {
      this.idleSince = undefined;
      this.idleDue = false;
    }
    const deadlines = [nextDeadline(state),
      this.idleSince === undefined ? undefined : this.idleSince + this.idleMs]
      .filter((value): value is number => value !== undefined);
    if (!deadlines.length) return;
    this.cancelTimer = this.clock.setTimer(() => this.enqueue(() => {
      const now = this.clock.now();
      this.apply([...(this.translator?.tick(now) ?? []), { type: "tick" }]);
      if (this.idleSince !== undefined && now >= this.idleSince + this.idleMs) {
        this.idleDue = true;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
      }
      this.wake();
    }), Math.max(0, Math.min(...deadlines) - this.clock.now()));
  }
  async flush(): Promise<void> { await this.tail; }
  stop(): void { this.stopped = true; this.cancelTimer?.(); }
}
