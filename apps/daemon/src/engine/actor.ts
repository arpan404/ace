import { type Fact } from "@ace/core";
import type { Frame, ProviderSession, Translator } from "@ace/engine-api";
import type { ThreadId, EventPayload, Capabilities } from "@ace/protocol";
import { z } from "zod";
import { isStoreBusy } from "../store-busy.ts";
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
const sdkBody = z.object({ kind: z.string(), body: z.unknown() });
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
  private pendingFrames: {
    frame: Frame;
    generation: number;
    bytes: number;
    resolve(): void;
    reject(error: unknown): void;
  }[] = [];
  private pendingBytes = 0;
  private cancelBatch: (() => void) | undefined;
  private overflowed = false;
  private pressure = false;
  private drains = new Set<() => void>();
  readonly outputFlow = {
    paused: () => this.pressure || this.repo.store.isHistoryWriting(),
    wait: async () => {
      await this.repo.store.writable();
      if (this.pressure) await new Promise<void>((resolve) => this.drains.add(resolve));
    },
  };
  private updatePressure(): void {
    if (
      this.backlog().frames >=
        Math.min(256, Math.max(1, Math.floor(this.limits.maxQueuedFrames / 4))) ||
      this.backlog().bytes >= this.limits.maxQueuedBytes / 4
    )
      this.pressure = true;
    if (
      this.backlog().frames <= Math.min(64, Math.floor(this.limits.maxQueuedFrames / 16)) &&
      this.backlog().bytes <= this.limits.maxQueuedBytes / 16
    ) {
      this.pressure = false;
      for (const resolve of this.drains) resolve();
      this.drains.clear();
    }
  }
  private cancelTimer: (() => void) | undefined;
  private stopped = false;
  private draining: () => boolean;
  private repo: EngineRepository;
  private clock: EngineClock;
  private batchScheduler: Pick<EngineClock, "setTimer">;
  private idleMs: number;
  private wake: () => void;
  private report: (error: unknown) => void;
  private diagnostic:
    | ((thread: ThreadId, raw: import("@ace/protocol").RawPayload[]) => void)
    | undefined;
  constructor(
    id: ThreadId,
    repo: EngineRepository,
    clock: EngineClock,
    idleMs: number,
    wake: () => void,
    report: (error: unknown) => void,
    limits: EngineLimits,
    privateDrain: () => boolean = () => false,
    batchScheduler: Pick<EngineClock, "setTimer"> = systemClock,
    diagnostic?: (thread: ThreadId, raw: import("@ace/protocol").RawPayload[]) => void,
  ) {
    this.draining = privateDrain;
    this.batchScheduler = batchScheduler;
    this.limits = limits;
    this.id = id;
    this.repo = repo;
    this.clock = clock;
    this.idleMs = idleMs;
    this.wake = wake;
    this.report = report;
    this.diagnostic = diagnostic;
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
    this.sealFrames();
    this.accept(run, 0);
  }
  private accept(run: () => void, bytes: number, frames = 1): boolean {
    if (this.stopped || this.overflowed) return false;
    if (
      this.queued + frames > this.limits.maxQueuedFrames ||
      this.queuedBytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.overflowed = true;
      // Preserve the accepted prefix, then fail explicitly instead of silently dropping facts.
      this.tail = this.tail
        .then(async () => {
          await this.runWhenWritable(() => {
            this.lifetime?.abort();
            this.session = undefined;
            this.translator = undefined;
            this.generation++;
            this.apply([
              {
                type: "process.exited",
                deliberate: false,
                message: "Provider mailbox capacity exceeded; resume the thread to recover",
              },
              { type: "queue.changed", source: "provider", count: 0 },
              {
                type: "item.upsert",
                agent: "root",
                item: "engine:overload",
                draft: {
                  type: "notice",
                  level: "error",
                  text: "Provider mailbox capacity exceeded; resume the thread to recover",
                  complete: true,
                },
              },
            ]);
            this.overflowed = false;
            this.wake();
          });
        })
        .catch((error: unknown) => this.fail(error));
      return false;
    }
    this.queued += frames;
    this.queuedBytes += bytes;
    this.updatePressure();
    this.tail = this.tail
      .then(async () => {
        await this.runWhenWritable(run);
      })
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.queued -= frames;
        this.queuedBytes -= bytes;
        this.updatePressure();
      });
    return true;
  }
  private async runWhenWritable(run: () => void): Promise<void> {
    while (!this.poisoned) {
      await this.repo.store.writable();
      try {
        // Reserve SQLite before translating: translators can consume native sequence state.
        this.repo.store.atomic(run);
        return;
      } catch (error) {
        if (!isStoreBusy(error)) throw error;
        await new Promise<void>((resolve) => this.clock.setTimer(resolve, 100));
      }
    }
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
  frame(frame: Frame, generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return Promise.resolve();
    if (this.poisoned) return Promise.reject(new Error("Provider frame failed to commit"));
    const result = frameSchema.safeParse(frame);
    if (!result.success) {
      this.enqueue(() => {
        throw result.error;
      });
      return this.flush();
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
      return this.flush();
    }
    if (bytes > this.limits.maxFrameBytes) {
      this.enqueue(() => {
        throw new Error("Provider frame capacity exceeded");
      });
      return this.flush();
    }
    if (this.overflowed) return Promise.reject(new Error("Provider mailbox capacity exceeded"));
    const acknowledgement = new Promise<void>((resolve, reject) => {
      this.pendingFrames.push({ frame: decoded, generation, bytes, resolve, reject });
      this.pendingBytes += bytes;
      this.updatePressure();
      this.cancelBatch ??= this.batchScheduler.setTimer(() => this.sealFrames(), 1);
      if (
        this.draining() ||
        this.backlog().frames >= this.limits.maxQueuedFrames ||
        this.backlog().bytes >= this.limits.maxQueuedBytes ||
        this.pendingFrames.length >= 256 ||
        this.pendingBytes >= 262144
      )
        this.sealFrames();
    });
    void acknowledgement.catch(() => {});
    return acknowledgement;
  }
  private sealFrames(): void {
    this.cancelBatch?.();
    this.cancelBatch = undefined;
    const pending = this.pendingFrames;
    if (!pending.length) return;
    const bytes = this.pendingBytes;
    this.pendingFrames = [];
    this.pendingBytes = 0;
    const admitted = this.accept(
      () => {
        const live = pending.filter((entry) => entry.generation === this.generation);
        const before = this.repo.requireState(this.id).status;
        const cursorSdk =
          this.repo.requireState(this.id).config.provider === "cursor" &&
          this.repo.backend(this.id) === "cursor-sdk";
        const facts = live.flatMap((entry) => this.translateFrame(entry.frame, cursorSdk));
        this.apply(facts);
        if (
          live.some((entry) => entry.frame.channel === "sdk") &&
          facts.some((fact) => fact.type === "process.exited" && !fact.deliberate)
        )
          this.lifetime?.abort();
        if (
          before !== this.repo.requireState(this.id).status ||
          facts.some((fact) =>
            [
              "turn.started",
              "input.admitted",
              "turn.ended",
              "process.exited",
              "queue.changed",
              "limit.cleared",
              "interaction.closed",
              "background.ended",
              "retry",
            ].includes(fact.type),
          )
        ) {
          this.syncQueue();
          this.wake();
        }
      },
      bytes,
      pending.length,
    );
    const commit = this.tail;
    void commit.then(
      () => {
        for (const entry of pending) {
          if (!admitted || this.poisoned || this.overflowed)
            entry.reject(new Error("Provider frame failed to commit"));
          else entry.resolve();
        }
      },
      (error) => {
        for (const entry of pending) entry.reject(error);
      },
    );
  }
  private translateFrame(decoded: Frame, cursorBackend: boolean): Fact[] {
    const cursorSdk = decoded.channel === "sdk" && cursorBackend;
    if (cursorSdk && this.repo.recovery.committed(this.id, decoded)) return [];
    const facts = this.translator?.translate(decoded, this.clock.now()) ?? [];
    const raw = this.translator?.takeDiagnostics?.() ?? [];
    if (raw.length) this.diagnostic?.(this.id, raw);
    if (cursorSdk) {
      const body = sdkBody.safeParse(decoded.data);
      if (body.success && body.data.kind === "blob")
        this.repo.store.appendRawChunk(this.id, body.data.body);
      this.repo.captureFrame(this.id, decoded);
      // The outer mailbox transaction commits provenance, offsets and facts together.
      this.repo.recovery.commit(this.id, decoded);
    }
    return facts;
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
    this.repo.apply(this.id, facts, this.clock.now(), this.generation);
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
      this.repo.deadline(this.id, this.translator?.nextDeadline?.()),
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
    return {
      frames: this.queued + this.pendingFrames.length,
      bytes: this.queuedBytes + this.pendingBytes,
    };
  }
  async flush(): Promise<void> {
    this.sealFrames();
    await this.repo.store.writable();
    let pending: Promise<void>;
    do {
      pending = this.tail;
      await pending;
    } while (pending !== this.tail);
  }
  stop(): void {
    this.sealFrames();
    this.stopped = true;
    for (const id of this.inputLeases.keys()) this.releaseInput(id);
    this.cancelTimer?.();
    this.pressure = false;
    for (const resolve of this.drains) resolve();
    this.drains.clear();
  }
}
