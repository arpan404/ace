import type { PosixOperation, PosixReply, PosixValue } from "./posix-wire.ts";
import type { PosixLaneOptions, PosixLimits } from "./posix-executor.ts";
import { LaneCapacity } from "./posix-capacity.ts";
import { ChangeFence } from "./posix-fence.ts";
import { HandleTable } from "./posix-handle-table.ts";
import {
  CommandCallError,
  cancelled,
  closedHandle,
  stopped,
  unfinished,
  admissionRefusal,
  newJob,
  type Executor,
  type Job,
  type Lane,
} from "./posix-lane-types.ts";
import { SparePool } from "./posix-spares.ts";
import {
  CommandFilesystemUnavailable,
  CommandWriteOutcomeUnknown,
  consumedBy,
  created,
  createdBy,
  handlesOf,
  identityOf,
  isChange,
} from "./posix-ops.ts";

export type { PosixValue };
export { CommandCallError } from "./posix-lane-types.ts";
export type {
  PosixExecutor,
  PosixExecutorEvents,
  PosixLaneOptions,
  PosixLimits,
  SpawnPosixExecutor,
  StartTimer,
} from "./posix-executor.ts";

/**
 * Native calls, one lane per root. A lane owns one thread while it has work or open handles, so a
 * call blocked under one root (a dead network mount, a cloud placeholder) never delays another
 * root.
 *
 * Descriptors never leave their thread. Calls name handles: ids this side allocates and never
 * reuses, each owned by the thread that opened it and closed only there. When a thread is
 * abandoned at a deadline or crashes, its handles stop working here at once; a draining thread
 * closes everything it owns once its stuck call returns, then exits. So a reused descriptor
 * number can never be mistaken for an old one: numbers are never shared.
 */
export class PosixLanes {
  private readonly options: PosixLaneOptions;
  private limits: PosixLimits;
  private readonly lanes = new Map<string, Lane>();
  private readonly waiting: Lane[] = [];
  private readonly spares: SparePool;
  private readonly capacity = new LaneCapacity();
  private readonly fence = new ChangeFence();
  private readonly table = new HandleTable();
  private executors = 0;
  constructor(options: PosixLaneOptions) {
    this.options = options;
    this.limits = { ...options };
    this.spares = new SparePool(options.spares, options.idleMs, options.timer, (executor) =>
      this.retire(executor),
    );
  }

  /** Changes deadline and caps for later decisions; returns the restore. */
  configure(limits: Partial<PosixLimits>): () => void {
    const previous = this.limits;
    this.limits = { ...previous, ...limits };
    return () => {
      this.limits = previous;
    };
  }
  cleanup(): PosixLanes {
    return this;
  }
  /** Threads started and not yet confirmed stopped, draining ones included. */
  threads(): number {
    return this.capacity.threads();
  }
  /** A fresh handle id for a call that opens something. Never reused. */
  allocate(): number {
    return this.table.allocate();
  }
  /** The root an open handle belongs to. */
  rootOf(handle: number): string | undefined {
    return this.table.get(handle)?.root;
  }
  /** Resolves once `root` has no draining thread, so nothing abandoned there can still land. */
  settled(root: string): Promise<void> {
    return this.capacity.settled(root);
  }

  /**
   * Runs `operation` on the lane of the root its handles belong to, or of `root` when it names
   * none. A handle whose thread is gone fails at once.
   */
  run(
    root: string,
    operation: PosixOperation,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ value: PosixValue }> {
    if (operation.op === "close") {
      this.close(operation.handle);
      return Promise.resolve({ value: 0 });
    }
    const { signal } = options;
    const refuse = (error: Error) => {
      const consumed = consumedBy(operation);
      if (consumed !== undefined) this.close(consumed);
      return Promise.reject(error);
    };
    let owner: Executor | undefined;
    const identities: string[] = [];
    for (const handle of handlesOf(operation)) {
      const entry = this.table.get(handle);
      if (!entry) return refuse(closedHandle());
      if (owner && owner !== entry.executor)
        return refuse(
          new CommandFilesystemUnavailable("Command folder handles are on different threads"),
        );
      owner = entry.executor;
      root = entry.root;
      if (entry.identity !== undefined) identities.push(entry.identity);
    }
    if (signal?.aborted) return refuse(cancelled(signal));
    const refusal = admissionRefusal({
      change: isChange(operation),
      fenced: this.fenced(root, identities),
      newLane: !owner && !this.lanes.has(root),
      stuck: this.capacity.stuck(root),
      stuckPerRoot: this.options.stuckPerRoot,
      mayStart: this.capacity.mayStart(this.limits),
      spares: this.spares.size,
    });
    if (refusal) return refuse(refusal);
    // From here on the caller can't use a handle this call takes over.
    const consumed = consumedBy(operation);
    if (consumed !== undefined) this.table.delete(consumed);
    return new Promise((resolve, reject) => {
      const job = newJob(root, operation, owner, resolve, reject);
      job.identities = identities;
      if (signal) {
        const abort = () => this.cancel(job, cancelled(signal));
        signal.addEventListener("abort", abort, { once: true });
        job.unlisten = () => signal.removeEventListener("abort", abort);
      }
      this.enqueue(job);
    });
  }

  /**
   * Gives `handle` back. The caller is done at once: the close is sent to the owning thread, in
   * order after its queued calls, and never needs a new thread. If that thread is gone, it closes
   * the handle itself as it drains.
   */
  close(handle: number): void {
    const entry = this.table.get(handle);
    if (!entry) return;
    this.table.delete(handle);
    this.closeOn(entry.executor, handle);
  }

  private closeOn(executor: Executor, handle: number): void {
    const lane = executor.lane;
    if (executor.gone || !lane) return;
    lane.queue.push(newJob(lane.root, { op: "close", handle }, executor));
    this.pump(lane);
  }

  /** Whether a change to `identities` under `root` could race one that may still land. */
  private fenced(root: string, identities: readonly string[]): boolean {
    return this.capacity.stuck(root) > 0 || this.fence.blocks(identities);
  }

  private enqueue(job: Job): void {
    const existing = this.lanes.get(job.root);
    const lane = existing ?? { root: job.root, queue: [] };
    lane.queue.push(job);
    if (existing) return this.pump(lane);
    this.lanes.set(job.root, lane);
    this.admit(lane);
  }

  /** Gives a new lane a thread now, or queues it for one, failing at the deadline. */
  private admit(lane: Lane): void {
    const executor = this.take();
    if (executor) return this.bind(lane, executor);
    this.waiting.push(lane);
    lane.stopWaiting = this.options.timer(() => {
      lane.stopWaiting = undefined;
      this.fail(lane, new CommandFilesystemUnavailable("Too many command folders are busy"));
    }, this.limits.deadlineMs);
  }

  private take(): Executor | undefined {
    const reused = this.spares.take();
    if (reused) return reused;
    if (!this.capacity.canStart(this.limits)) return undefined;
    let executor: Executor | undefined;
    const native = this.options.spawn({
      reply: (reply) => executor && this.replied(executor, reply),
      failed: (error) => executor && this.failed(executor, error),
      exit: () => executor && this.exited(executor),
    });
    executor = { id: ++this.executors, native, exited: false, handles: new Set() };
    this.capacity.started();
    native.hold(false);
    return executor;
  }

  private bind(lane: Lane, executor: Executor): void {
    lane.stopWaiting?.();
    lane.stopWaiting = undefined;
    lane.executor = executor;
    executor.lane = lane;
    this.pump(lane);
  }

  /** Hands freed capacity to roots waiting for a thread, oldest first. */
  private wake(): void {
    for (let lane = this.waiting[0]; lane; lane = this.waiting[0]) {
      const executor = this.take();
      if (!executor) return;
      this.waiting.shift();
      this.bind(lane, executor);
    }
  }

  private pump(lane: Lane): void {
    const { executor } = lane;
    if (!executor || lane.running) return;
    const job = lane.queue.shift();
    if (!job) {
      if (executor.handles.size === 0) this.release(lane);
      return;
    }
    if (job.owner && job.owner !== executor) {
      // Its handles belonged to a thread this root no longer has.
      job.reject(closedHandle());
      return this.pump(lane);
    }
    // Checked again on dispatch: an earlier change may have timed out while this one waited.
    if (isChange(job.operation) && this.fenced(lane.root, job.identities)) {
      job.unlisten();
      job.reject(unfinished());
      return this.pump(lane);
    }
    const stop = this.options.timer(() => this.abandon(lane), this.limits.deadlineMs);
    lane.running = { job, stop };
    executor.inflight = job;
    executor.native.hold(true);
    executor.native.send(job.id, job.operation);
  }

  private replied(executor: Executor, reply: PosixReply): void {
    const job = executor.inflight;
    if (!job || job.id !== reply.id) return;
    executor.inflight = undefined;
    this.fence.landed(job);
    // A draining thread closes everything it owns, late results included, before it exits.
    if (executor.gone) return;
    const lane = executor.lane;
    const running = lane?.running;
    if (!lane || running?.job !== job) return;
    running.stop();
    lane.running = undefined;
    executor.native.hold(false);
    job.unlisten();
    const { operation } = job;
    const consumed = consumedBy(operation);
    if (consumed !== undefined) executor.handles.delete(consumed);
    if (operation.op === "close") executor.handles.delete(operation.handle);
    const handle = createdBy(operation);
    if (handle !== undefined && reply.ok && created(operation, reply.value)) {
      executor.handles.add(handle);
      // Nobody will close what a caller who gave up opened: close it here, first.
      if (job.detached) lane.queue.unshift(newJob(lane.root, { op: "close", handle }, executor));
      else this.table.set(handle, { root: lane.root, executor, identity: identityOf(reply.value) });
    }
    if (!job.detached) {
      if (reply.ok) job.resolve({ value: reply.value });
      else job.reject(new CommandCallError(reply.message, reply.code));
    }
    this.pump(lane);
  }

  /** The thread can't serve: its handles stop working and its root's calls fail. */
  private failed(executor: Executor, error: Error): void {
    if (executor.gone || executor.exited) return;
    executor.gone = "failed";
    this.capacity.stoppedServing();
    this.table.forget(executor);
    if (!this.spares.remove(executor) && executor.lane) this.fail(executor.lane, error);
    this.wake();
  }

  /** Only a confirmed exit gives a thread's slot back. */
  private exited(executor: Executor): void {
    if (executor.exited) return;
    if (!executor.gone) this.failed(executor, new Error("Command discovery worker exited"));
    executor.exited = true;
    // A thread that has exited is in no call: whatever it was changing can't land any more.
    if (executor.inflight) this.fence.landed(executor.inflight);
    executor.inflight = undefined;
    this.capacity.exited(executor.gone === "draining" ? (executor.root ?? "") : undefined);
    this.wake();
  }

  /**
   * The caller stops waiting. A queued call is dropped unrun. A running one finishes on its
   * thread, and what it opened is closed there; a change reports that its outcome is unknown,
   * since it may still land.
   */
  private cancel(job: Job, error: Error): void {
    const lane = this.lanes.get(job.root);
    if (!lane) return;
    if (lane.running?.job === job) {
      job.detached = true;
      job.unlisten();
      this.fence.hold(job);
      return job.reject(
        isChange(job.operation)
          ? new CommandWriteOutcomeUnknown("A change to a command folder was cancelled", job.root)
          : error,
      );
    }
    const at = lane.queue.indexOf(job);
    if (at < 0) return;
    lane.queue.splice(at, 1);
    this.drop(job, error);
    if (lane.executor && !lane.running) this.pump(lane);
    else if (!lane.executor && lane.queue.length === 0) this.forget(lane);
  }

  /** A call that will never run. What it would have taken over is closed on its thread. */
  private drop(job: Job, error: Error): void {
    job.unlisten();
    const consumed = consumedBy(job.operation);
    if (consumed !== undefined && job.owner) this.closeOn(job.owner, consumed);
    job.reject(error);
  }

  /** The running call outlived its deadline: its thread drains and is never handed work again. */
  private abandon(lane: Lane): void {
    const { executor, running } = lane;
    if (!executor || !running) return;
    executor.gone = "draining";
    executor.root = lane.root;
    this.capacity.drained(lane.root);
    this.table.forget(executor);
    executor.native.hold(false);
    executor.native.drain();
    this.fence.hold(running.job);
    const change = isChange(running.job.operation);
    this.fail(
      lane,
      change
        ? new CommandWriteOutcomeUnknown("A change to a command folder timed out", lane.root)
        : stopped(),
      stopped(),
    );
  }

  /** Every call on the lane fails; closes are moot, since the thread closes what it owns. */
  private fail(lane: Lane, error: Error, queued: Error = error): void {
    this.forget(lane);
    const running = lane.running;
    lane.running = undefined;
    const jobs = lane.queue;
    lane.queue = [];
    if (running) {
      running.stop();
      running.job.unlisten();
      if (!running.job.detached) running.job.reject(error);
    }
    for (const job of jobs) {
      job.unlisten();
      if (job.operation.op === "close") job.resolve({ value: 0 });
      else job.reject(queued);
    }
    this.wake();
  }

  /** An idle lane gives its thread to a waiting root, keeps it as a spare, or lets it exit. */
  private release(lane: Lane): void {
    const { executor } = lane;
    this.forget(lane);
    if (!executor || executor.gone) return;
    const next = this.waiting.shift();
    if (next) return this.bind(next, executor);
    if (!this.spares.offer(executor)) this.retire(executor);
  }

  /** Stops serving now; the thread still counts against the cap until it has exited. */
  private retire(executor: Executor): void {
    executor.gone = "retired";
    this.capacity.stoppedServing();
    executor.native.drain();
    this.wake();
  }

  private forget(lane: Lane): void {
    if (this.lanes.get(lane.root) === lane) this.lanes.delete(lane.root);
    if (lane.executor?.lane === lane) lane.executor.lane = undefined;
    lane.executor = undefined;
    lane.stopWaiting?.();
    lane.stopWaiting = undefined;
    const at = this.waiting.indexOf(lane);
    if (at >= 0) this.waiting.splice(at, 1);
  }
}
