import { nextDeadline, type Fact } from "@ace/core";
import type { Frame, ProviderSession, Translator } from "@ace/engine-api";
import type { ThreadId, EventPayload, Capabilities } from "@ace/protocol";
import { z } from "zod";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { boundedJson } from "@ace/provider-kit/ipc";
import type { EngineLimits } from "./limits.ts";
import type { EngineRepository } from "./repository.ts";

const frameSchema = z.object({
  seq: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  dir: z.enum(["send", "recv", "stderr", "note"]),
  channel: z.string(),
  data: z.unknown(),
  payload: z.custom<ProviderPayload>(ProviderPayload.is).optional(),
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
  effectiveCapabilities: Capabilities | undefined;
  lifetime: AbortController | undefined;
  generation = 0;
  poisoned = false;
  idleSince: number | undefined;
  idleDue = false;
  private inputLeases = new Map<number, { release(): void; runId: string | undefined }>();
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
  retainInput(id: number, release: () => void, runId: string | undefined): void {
    if (this.inputLeases.size >= 256) {
      release();
      throw new Error("Input lease capacity exceeded");
    }
    this.inputLeases.set(id, { release, runId });
  }
  releaseInput(id: number): void {
    const lease = this.inputLeases.get(id);
    this.inputLeases.delete(id);
    lease?.release();
  }
  releaseInputs(): void {
    for (const id of this.inputLeases.keys()) this.releaseInput(id);
  }
  observeInputs(events: EventPayload[]): void {
    for (const event of events) {
      if (
        event.type === "run.started" &&
        event.run.agentId ===
          this.repo.requireState(this.id).agents[this.repo.requireState(this.id).rootKey ?? ""]
            ?.agent.id
      ) {
        for (const lease of this.inputLeases.values())
          if (lease.runId === undefined) lease.runId = event.run.id;
      } else if (event.type === "run.ended") {
        for (const [id, lease] of this.inputLeases)
          if (lease.runId === event.runId) this.releaseInput(id);
      }
    }
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
    const { payload, ...metadata } = result.data;
    const decoded: Frame = { ...metadata, ...(payload ? { payload } : {}) };
    let bytes: number;
    try {
      const certificate = decoded.payload;
      if (decoded.channel === "sdk" && (!certificate || certificate.data !== decoded.data))
        throw new Error("SDK frame lacks matching encoded admission certificate");
      bytes =
        certificate && certificate.data === decoded.data
          ? certificate.bytes + 512
          : Buffer.byteLength(boundedJson(decoded, this.limits.maxFrameBytes));
    } catch (error) {
      this.enqueue(() => {
        throw error;
      });
      return;
    }
    this.accept(() => {
      if (generation !== this.generation) return;
      if (this.repo.recovery.committed(this.id, decoded)) return;
      const facts = this.translator?.translate(decoded, this.clock.now()) ?? [];
      const before = this.repo.requireState(this.id).status;
      this.repo.store.atomic(() => {
        const body = z.object({ kind: z.string(), body: z.unknown() }).safeParse(decoded.data);
        if (decoded.channel === "sdk" && body.success && body.data.kind === "blob")
          this.repo.store.appendRawChunk(this.id, body.data.body);
        this.repo.captureFrame(this.id, decoded);
        this.apply(facts);
        if (
          facts.some(
            (fact) =>
              fact.type === "turn.started" ||
              fact.type === "input.admitted" ||
              fact.type === "turn.ended" ||
              fact.type === "process.exited" ||
              fact.type === "queue.changed" ||
              fact.type === "limit.cleared" ||
              (fact.type === "retry" && fact.on === "rate_limit"),
          )
        )
          this.syncQueue();
        this.repo.recovery.commit(this.id, decoded);
      });
      if (
        decoded.channel === "sdk" &&
        facts.some((fact) => fact.type === "process.exited" && !fact.deliberate)
      )
        this.lifetime?.abort();
      if (
        before !== this.repo.requireState(this.id).status ||
        facts.some(
          (fact) =>
            fact.type === "turn.started" ||
            fact.type === "input.admitted" ||
            fact.type === "turn.ended" ||
            fact.type === "queue.changed" ||
            fact.type === "process.exited" ||
            fact.type === "background.ended" ||
            fact.type === "interaction.closed",
        )
      )
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
    if (facts.some((fact) => fact.type === "process.exited"))
      for (const id of this.inputLeases.keys()) this.releaseInput(id);
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
  backlog(): { frames: number; bytes: number } {
    return { frames: this.queued, bytes: this.queuedBytes };
  }
  async flush(): Promise<void> {
    await this.tail;
  }
  stop(): void {
    this.stopped = true;
    for (const id of this.inputLeases.keys()) this.releaseInput(id);
    this.cancelTimer?.();
  }
}
