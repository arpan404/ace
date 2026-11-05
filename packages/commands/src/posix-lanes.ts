import type { PosixOperation, PosixReply, PosixValue } from "./posix-wire.ts";
import { DescriptorLedger } from "./posix-ledger.ts";
import {
  CommandFilesystemUnavailable,
  CommandWriteOutcomeUnknown,
  consumedBy,
  inputsOf,
  isChange,
  isRelease,
} from "./posix-ops.ts";

export type { PosixValue };

/** One thread that runs native calls one at a time, in the order they are sent. */
export interface PosixExecutor {
  send(id: number, operation: PosixOperation): void;
  /** Whether the executor keeps the process alive; true only while a call is running. */
  hold(busy: boolean): void;
  /**
   * Stop handing it work. Once its current call returns, the thread closes what that call
   * opened (when `abandoned` names it) and every directory stream it holds, then exits. It must
   * never keep the process alive afterwards.
   */
  drain(abandoned?: number): void;
}
export interface PosixExecutorEvents {
  reply(reply: PosixReply): void;
  /** The thread can't serve any more (an uncaught error); it has not necessarily stopped. */
  failed(error: Error): void;
  /** The thread has stopped. A draining thread stops only once its blocked call returns. */
  exit(): void;
}
export type SpawnPosixExecutor = (events: PosixExecutorEvents) => PosixExecutor;
/** Starts a timer and returns its cancel. */
export type StartTimer = (run: () => void, ms: number) => () => void;

export interface PosixLimits {
  /** How long one native call may run, or a root wait for a thread, before it fails. */
  deadlineMs: number;
  /** Threads serving roots or waiting as spares. Further roots wait for one. */
  maxWorkers: number;
  /** Every thread not yet confirmed stopped, draining ones included. None starts beyond it. */
  maxThreads: number;
}
export interface PosixLaneOptions extends PosixLimits {
  spawn: SpawnPosixExecutor;
  timer: StartTimer;
  /** How long a spare thread waits for work before it exits. */
  idleMs: number;
  /** Idle threads kept for the next root. */
  spares: number;
  /** Draining threads a root may have before its calls fail at once. */
  stuckPerRoot: number;
}
export interface RunOptions {
  /** The call belongs to state in that executor (a directory stream). */
  executor?: number;
  signal?: AbortSignal;
}

interface Executor {
  id: number;
  native: PosixExecutor;
  lane?: Lane | undefined;
  /** Set once it serves no one: draining after a deadline, retired when idle, or failed. */
  gone?: "draining" | "retired" | "failed" | undefined;
  /** The root a draining thread counts against. */
  root?: string | undefined;
  /** The call sent and not yet answered: its inputs stay pinned until it returns. */
  inflight?: Job | undefined;
  exited: boolean;
  stopIdle?: (() => void) | undefined;
  /** Directory streams open on this thread, by reader id, with the descriptor each owns. */
  streams: Map<number, number>;
}
interface Job {
  id: number;
  root: string;
  operation: PosixOperation;
  resolve(result: { value: PosixValue; executor: number }): void;
  reject(error: Error): void;
  /** The caller gave up while it ran; its answer is released, not delivered. */
  detached: boolean;
  pinned: number[];
  unlisten(): void;
}
interface Lane {
  root: string;
  executor?: Executor | undefined;
  queue: Job[];
  running?: { job: Job; stop: () => void } | undefined;
  /** Directory streams open on this executor; they keep it bound to the root. */
  readers: Set<number>;
  stopWaiting?: (() => void) | undefined;
}

const quiet = () => {};
const stopped = () => new CommandFilesystemUnavailable("Command folder stopped responding");

/**
 * Native calls, one lane per root. A lane owns one thread while it has work or open readers, so
 * a call blocked under one root (a dead network mount, a cloud placeholder) never delays another
 * root. A call that outlives its deadline drains its thread: nothing more is sent to it, and once
 * the blocked call returns, the thread itself closes what it owns and exits.
 *
 * Descriptor ownership: a descriptor a call names is pinned from when the call is queued until it
 * has returned natively. A close of a pinned descriptor waits for that, so a call that was
 * cancelled, or abandoned mid-syscall, can never act on a number the daemon has since reused.
 */
export class PosixLanes {
  private readonly options: PosixLaneOptions;
  private limits: PosixLimits;
  private readonly lanes = new Map<string, Lane>();
  private readonly waiting: Lane[] = [];
  private readonly spare: Executor[] = [];
  private readonly draining = new Map<string, number>();
  private readonly settles = new Map<string, (() => void)[]>();
  private readonly ledger = new DescriptorLedger();
  private drainingTotal = 0;
  private live = 0;
  private allocated = 0;
  private executors = 0;
  private jobs = 0;
  constructor(options: PosixLaneOptions) {
    this.options = options;
    this.limits = { ...options };
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
    return this.allocated;
  }
  /** Resolves once `root` has no draining thread, so nothing abandoned there can still land. */
  settled(root: string): Promise<void> {
    if (!this.draining.has(root)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.settles.get(root) ?? [];
      list.push(resolve);
      this.settles.set(root, list);
    });
  }

  run(
    root: string,
    operation: PosixOperation,
    options: RunOptions = {},
  ): Promise<{ value: PosixValue; executor: number }> {
    const { signal } = options;
    const release = isRelease(operation);
    const refuse = (error: Error) => {
      const consumed = consumedBy(operation);
      if (consumed !== undefined) this.close(root, consumed);
      return Promise.reject(error);
    };
    const consumed = consumedBy(operation);
    if (consumed !== undefined && this.ledger.owns(consumed))
      return Promise.reject(new CommandFilesystemUnavailable("Descriptor is already closing"));
    if (!release && signal?.aborted) return refuse(cancelled(signal));
    const lane = this.lanes.get(root);
    if (options.executor !== undefined && lane?.executor?.id !== options.executor)
      return refuse(new CommandFilesystemUnavailable("Directory reader was abandoned"));
    const stuck = this.draining.get(root) ?? 0;
    if (!release && stuck > 0) {
      if (isChange(operation))
        return refuse(
          new CommandFilesystemUnavailable("An earlier change to this folder hasn't finished"),
        );
      // A root that already left a thread stuck can't take the threads kept for healthy roots.
      const reserved = this.limits.maxThreads - this.limits.maxWorkers;
      if (!lane && (stuck >= this.options.stuckPerRoot || this.drainingTotal >= reserved))
        return refuse(new CommandFilesystemUnavailable("Command folder is still not responding"));
    }
    return new Promise((resolve, reject) => {
      const job = this.job(root, operation, resolve, reject);
      if (signal && !release) {
        const abort = () => this.cancel(job, cancelled(signal));
        signal.addEventListener("abort", abort, { once: true });
        job.unlisten = () => signal.removeEventListener("abort", abort);
      }
      this.enqueue(job);
    });
  }

  /**
   * Closes `fd` on `root`'s thread once no call that names it is still running natively. Never
   * refused and never dropped; it waits for a thread if it must.
   */
  close(root: string, fd: number): void {
    if (this.ledger.take(fd)) this.closeOwned(root, fd);
  }

  private closeOwned(root: string, fd: number): void {
    if (this.ledger.closable(root, fd))
      this.enqueue(this.job(root, { op: "closeFd", fd }, quiet, quiet));
  }

  private job(
    root: string,
    operation: PosixOperation,
    resolve: Job["resolve"],
    reject: Job["reject"],
  ): Job {
    const pinned = inputsOf(operation);
    this.ledger.pin(pinned);
    const consumed = consumedBy(operation);
    if (consumed !== undefined) this.ledger.take(consumed);
    return {
      id: ++this.jobs,
      root,
      operation,
      resolve,
      reject,
      detached: false,
      pinned,
      unlisten: quiet,
    };
  }

  /** The call no longer names its descriptors; closes waiting on them go ahead. */
  private unpin(job: Job): void {
    const pinned = job.pinned;
    job.pinned = [];
    for (const { root, fd } of this.ledger.unpin(pinned)) this.closeOwned(root, fd);
  }

  /** A call that will never be sent: it gives back its pins and what it would have consumed. */
  private drop(job: Job, error: Error | undefined): void {
    job.unlisten();
    this.unpin(job);
    const consumed = consumedBy(job.operation);
    if (consumed !== undefined) this.closeOwned(job.root, consumed);
    if (error) job.reject(error);
  }

  private enqueue(job: Job): void {
    const existing = this.lanes.get(job.root);
    const lane = existing ?? { root: job.root, queue: [], readers: new Set<number>() };
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
    const reused = this.spare.pop();
    if (reused) {
      reused.stopIdle?.();
      reused.stopIdle = undefined;
      return reused;
    }
    if (this.live >= this.limits.maxWorkers || this.allocated >= this.limits.maxThreads)
      return undefined;
    let executor: Executor | undefined;
    const native = this.options.spawn({
      reply: (reply) => executor && this.replied(executor, reply),
      failed: (error) => executor && this.failed(executor, error),
      exit: () => executor && this.exited(executor),
    });
    executor = { id: ++this.executors, native, exited: false, streams: new Map() };
    this.live++;
    this.allocated++;
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
      if (lane.readers.size === 0) this.release(lane);
      return;
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
    // The call has returned natively: its descriptors are free again, even from a draining
    // thread. What a draining thread opened, it closes itself before exiting.
    this.unpin(job);
    this.settleOwnership(executor, job, reply);
    if (executor.gone) return;
    const lane = executor.lane;
    const running = lane?.running;
    if (!lane || running?.job !== job) return;
    running.stop();
    lane.running = undefined;
    executor.native.hold(false);
    job.unlisten();
    const { operation } = job;
    if (operation.op === "closeDirectory") lane.readers.delete(operation.reader);
    const opened = reply.ok && typeof reply.value === "number" ? reply.value : -1;
    if (operation.op === "openDirectory" && opened > 0) lane.readers.add(opened);
    if (job.detached) {
      // Nobody will close what the caller who gave up would have: release it here, first.
      if (operation.op === "openDirectory" && opened > 0)
        lane.queue.unshift(
          this.job(lane.root, { op: "closeDirectory", reader: opened }, quiet, quiet),
        );
      if ((operation.op === "open" || operation.op === "create") && opened >= 0)
        lane.queue.unshift(this.job(lane.root, { op: "closeFd", fd: opened }, quiet, quiet));
    } else if (reply.ok) job.resolve({ value: reply.value, executor: executor.id });
    else job.reject(new Error(reply.message));
    this.pump(lane);
  }

  /** Who owns a descriptor once a call that takes or closes one has returned. */
  private settleOwnership(executor: Executor, job: Job, reply: PosixReply): void {
    const { operation } = job;
    if (operation.op === "openDirectory") {
      // A stream owns the descriptor; without one, the worker has closed it.
      if (reply.ok && typeof reply.value === "number" && reply.value > 0)
        executor.streams.set(reply.value, operation.fd);
      else this.ledger.closed(operation.fd);
    } else if (operation.op === "closeDirectory") {
      const fd = executor.streams.get(operation.reader);
      executor.streams.delete(operation.reader);
      if (fd !== undefined) this.ledger.closed(fd);
    } else if (operation.op === "closeFd") this.ledger.closed(operation.fd);
  }

  /** The thread can't serve: its root's calls fail. It still counts until it exits. */
  private failed(executor: Executor, error: Error): void {
    if (executor.gone || executor.exited) return;
    executor.gone = "failed";
    this.live--;
    const spare = this.spare.indexOf(executor);
    if (spare >= 0) {
      this.spare.splice(spare, 1);
      executor.stopIdle?.();
    } else if (executor.lane) this.fail(executor.lane, error);
    this.wake();
  }

  /** Only a confirmed exit gives a thread back, and only then do its pins end. */
  private exited(executor: Executor): void {
    if (executor.exited) return;
    if (!executor.gone) this.failed(executor, new Error("Command discovery worker exited"));
    const drained = executor.gone === "draining" || executor.gone === "retired";
    executor.exited = true;
    this.allocated--;
    const job = executor.inflight;
    executor.inflight = undefined;
    if (job) this.unpin(job);
    // A drained thread returned from its last call and closed every stream before exiting. A
    // crashed one may not have: its descriptors stay owned, so their numbers are never reused.
    if (drained) {
      for (const fd of executor.streams.values()) this.ledger.closed(fd);
      const operation = job?.operation;
      if (operation?.op === "openDirectory" || operation?.op === "closeFd")
        this.ledger.closed(operation.fd);
    }
    executor.streams.clear();
    if (executor.gone === "draining") {
      const root = executor.root ?? "";
      const left = (this.draining.get(root) ?? 1) - 1;
      this.drainingTotal--;
      if (left > 0) this.draining.set(root, left);
      else {
        this.draining.delete(root);
        for (const resolve of this.settles.get(root) ?? []) resolve();
        this.settles.delete(root);
      }
    }
    this.wake();
  }

  /**
   * The caller stops waiting. A queued call is dropped unrun. A running one keeps its thread and
   * descriptors until it returns, then its result is released; a change reports that its outcome
   * is unknown, since it may still land.
   */
  private cancel(job: Job, error: Error): void {
    const lane = this.lanes.get(job.root);
    if (!lane) return;
    if (lane.running?.job === job) {
      job.detached = true;
      job.unlisten();
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
    if (lane.executor && !lane.running && lane.queue.length === 0 && lane.readers.size === 0)
      this.release(lane);
    if (!lane.executor && lane.queue.length === 0) this.forget(lane);
  }

  /** The running call outlived its deadline: its thread drains and is never handed work again. */
  private abandon(lane: Lane): void {
    const { executor, running } = lane;
    if (!executor || !running) return;
    executor.gone = "draining";
    executor.root = lane.root;
    this.live--;
    this.drainingTotal++;
    this.draining.set(lane.root, (this.draining.get(lane.root) ?? 0) + 1);
    executor.native.hold(false);
    executor.native.drain(running.job.id);
    const change = isChange(running.job.operation);
    this.fail(
      lane,
      change
        ? new CommandWriteOutcomeUnknown("A change to a command folder timed out", lane.root)
        : stopped(),
      stopped(),
    );
  }

  /**
   * Every call on the lane fails, and its readers die with its executor. The running call keeps
   * its pins until its thread returns or exits. Queued closes move to the root's next thread.
   */
  private fail(lane: Lane, error: Error, queued: Error = error): void {
    this.forget(lane);
    const running = lane.running;
    lane.running = undefined;
    const jobs = lane.queue;
    lane.queue = [];
    lane.readers.clear();
    if (running) {
      running.stop();
      running.job.unlisten();
      if (!running.job.detached) running.job.reject(error);
    }
    for (const job of jobs) {
      if (job.operation.op === "closeFd") this.enqueue(job);
      // A stream dies with its thread; a draining thread closes its own streams.
      else if (job.operation.op === "closeDirectory") {
        this.drop(job, undefined);
        job.resolve({ value: 0, executor: 0 });
      } else this.drop(job, queued);
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
    if (this.spare.length >= this.options.spares) return this.retire(executor);
    this.spare.push(executor);
    executor.stopIdle = this.options.timer(() => {
      const at = this.spare.indexOf(executor);
      if (at < 0) return;
      this.spare.splice(at, 1);
      this.retire(executor);
    }, this.options.idleMs);
  }

  /** Stops serving now; the thread still counts against the cap until it has exited. */
  private retire(executor: Executor): void {
    executor.gone = "retired";
    this.live--;
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

function cancelled(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new CommandFilesystemUnavailable("Command filesystem call cancelled");
}
