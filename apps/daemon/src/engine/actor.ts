import { nextDeadline, type Fact } from "@ace/core";
import type { Frame, ProviderSession, Translator } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { EngineLimits } from "./limits.ts";
import type { EngineRepository } from "./repository.ts";

const frameSchema = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.string(),
  data: z.unknown(),
});
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
  translator: Translator | undefined;
  session: ProviderSession | undefined;
  lifetime: AbortController | undefined;
  generation = 0;
  poisoned = false;
  idleSince: number | undefined;
  idleDue = false;
  private queued = 0;
  private queuedBytes = 0;
  private limits: EngineLimits;
  private tail: Promise<void> = Promise.resolve();
  private cancelTimer: (() => void) | undefined;
  private stopped = false;
  private repo: EngineRepository;
  private clock: EngineClock;
  private idleMs: number;
  private wake: () => void;
  private report: (error: unknown) => void;
  constructor(
    id: ThreadId,
    repo: EngineRepository,
    clock: EngineClock,
    idleMs: number,
    wake: () => void,
    report: (error: unknown) => void,
    limits: EngineLimits,
  ) {
    this.limits = limits;
    this.id = id;
    this.repo = repo;
    this.clock = clock;
    this.idleMs = idleMs;
    this.wake = wake;
    this.report = report;
  }
  enqueue(run: () => void): void {
    this.accept(run, 0);
  }
  private accept(run: () => void, bytes: number): void {
    if (this.stopped) return;
    if (
      this.queued >= this.limits.maxQueuedFrames ||
      bytes > this.limits.maxFrameBytes ||
      this.queuedBytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.stop();
      // Preserve the accepted prefix, then fail explicitly instead of silently dropping facts.
      this.tail = this.tail
        .then(() => {
          throw new Error("Provider mailbox capacity exceeded");
        })
        .catch((error: unknown) => this.fail(error));
      return;
    }
    this.queued++;
    this.queuedBytes += bytes;
    this.tail = this.tail
      .then(() => {
        if (!this.poisoned) run();
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.queued--;
        this.queuedBytes -= bytes;
      });
  }
  private fail(error: unknown): void {
    this.poisoned = true;
    this.repo.evict(this.id);
    this.lifetime?.abort();
    this.report(error);
    try {
      this.repo.apply(
        this.id,
        [
          {
            type: "item.upsert",
            agent: "root",
            item: "engine:failure",
            draft: {
              type: "notice",
              level: "error",
              text: error instanceof Error ? error.message : String(error),
              complete: true,
            },
          },
        ],
        this.clock.now(),
      );
    } catch (failure) {
      this.report(failure);
    }
    this.wake();
  }
  frame(frame: Frame, generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    const result = frameSchema.safeParse(frame);
    if (!result.success) {
      this.enqueue(() => {
        throw result.error;
      });
      return;
    }
    const decoded = result.data;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(decoded));
    } catch (error) {
      this.enqueue(() => {
        throw error;
      });
      return;
    }
    this.accept(() => {
      if (generation !== this.generation) return;
      const facts = this.translator?.translate(decoded, this.clock.now()) ?? [];
      this.repo.store.atomic(() => {
        this.apply(facts);
        this.syncQueue();
      });
      this.wake();
    }, bytes);
  }
  private queueFact(): Extract<Fact, { type: "queue.changed" }> {
    return {
      type: "queue.changed",
      source: "engine",
      count: this.repo.queuedCount(this.id),
    };
  }
  syncQueue(): void {
    const fact = this.queueFact();
    if (this.repo.state(this.id)?.queueSources.engine !== fact.count) this.apply([fact]);
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
    if (state.status.state === "done" && this.session) {
      this.idleSince ??= this.clock.now();
    } else {
      this.idleSince = undefined;
      this.idleDue = false;
    }
    const deadlines = [
      nextDeadline(state, this.translator?.nextDeadline?.()),
      this.idleSince === undefined ? undefined : this.idleSince + this.idleMs,
    ].filter((value): value is number => value !== undefined);
    if (!deadlines.length) return;
    this.cancelTimer = this.clock.setTimer(
      () =>
        this.enqueue(() => {
          const now = this.clock.now();
          this.apply([...(this.translator?.tick(now) ?? []), { type: "tick" }]);
          if (this.idleSince !== undefined && now >= this.idleSince + this.idleMs) {
            this.idleDue = true;
            this.cancelTimer?.();
            this.cancelTimer = undefined;
          }
          this.wake();
        }),
      Math.max(0, Math.min(...deadlines) - this.clock.now()),
    );
  }
  async flush(): Promise<void> {
    await this.tail;
  }
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
  }
}
