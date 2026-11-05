import type { PosixOperation, PosixReply } from "./posix-wire.ts";

export type PosixValue = number | string | null;

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
  /** The thread has stopped. A draining thread stops only once its blocked call returns. */
  exit(error: Error): void;
}
export type SpawnPosixExecutor = (events: PosixExecutorEvents) => PosixExecutor;
/** Starts a timer and returns its cancel. */
export type StartTimer = (run: () => void, ms: number) => () => void;

export interface PosixLaneOptions {
  spawn: SpawnPosixExecutor;
  timer: StartTimer;
  /** How long one native call may run, or a root wait for a thread, before it fails. */
  deadlineMs: number;
  /** How long a spare thread waits for work before it exits. */
  idleMs: number;
  /** Idle threads kept for the next root. */
  spares: number;
  /** Draining threads a root may have before its calls fail at once. */
  stuckPerRoot: number;
  /** Threads serving roots or waiting as spares. Further roots wait for one. */
  maxWorkers: number;
  /** Every thread, draining ones included. No thread is started beyond it. */
  maxThreads: number;
}

/** A command folder's call failed without an answer: it stopped responding, or was cancelled. */
export class CommandFilesystemUnavailable extends Error {}
/** A change timed out: it may still land, or may have landed, after the caller gave up. */
export class CommandWriteOutcomeUnknown extends CommandFilesystemUnavailable {}

const mutating = new Set<PosixOperation["op"]>([
  "create",
  "rename",
  "link",
  "unlink",
  "mkdir",
  "symlink",
  "renameFlags",
]);

interface Executor {
  id: number;
  native: PosixExecutor;
  lane?: Lane | undefined;
  /** Set once it no longer serves anyone: draining, retired or crashed. */
  gone?: "draining" | "retired" | "ended" | undefined;
  root?: string | undefined;
  stopIdle?: (() => void) | undefined;
}
interface Job {
  id: number;
  operation: PosixOperation;
  resolve(result: { value: PosixValue; executor: number }): void;
  reject(error: Error): void;
  /** The caller gave up while it ran; its answer is released, not delivered. */
  detached: boolean;
  settled: () => void;
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
export interface RunOptions {
  /** The call belongs to state in that executor (a directory stream). */
  executor?: number;
  signal?: AbortSignal;
  /** Called once the call has left its thread for good. */
  settled?: () => void;
}

const quiet = () => {};

/**
 * Native calls, one lane per root. A lane owns one thread while it has work or open readers, so
 * a call blocked under one root (a dead network mount, a cloud placeholder) never delays another
 * root. A call that outlives its deadline drains its thread: nothing more is sent to it, and once
 * the blocked call returns, the thread itself closes what it owns and exits. The root's next call
 * starts on another thread, except changes, which fail while the abandoned one may still land.
 */
export class PosixLanes {
  private readonly options: PosixLaneOptions;
  private readonly lanes = new Map<string, Lane>();
  private readonly waiting: Lane[] = [];
  private readonly spare: Executor[] = [];
  private readonly draining = new Map<string, number>();
  private drainingTotal = 0;
  private live = 0;
  private executors = 0;
  private jobs = 0;
  constructor(options: PosixLaneOptions) {
    this.options = options;
  }

  cleanup(): PosixLanes {
    return this;
  }

  /** Threads started and not yet stopped, draining ones included. */
  threads(): number {
    return this.live + this.drainingTotal;
  }

  run(
    root: string,
    operation: PosixOperation,
    options: RunOptions = {},
  ): Promise<{ value: PosixValue; executor: number }> {
    const { signal, settled = quiet } = options;
    const refuse = (error: Error) => {
      settled();
      return Promise.reject(error);
    };
    if (signal?.aborted) return refuse(cancelled(signal));
    let lane = this.lanes.get(root);
    if (options.executor !== undefined && lane?.executor?.id !== options.executor)
      return refuse(new CommandFilesystemUnavailable("Directory reader was abandoned"));
    const stuck = this.draining.get(root) ?? 0;
    if (stuck > 0 && mutating.has(operation.op))
      return refuse(
        new CommandFilesystemUnavailable("An earlier change to this folder hasn't finished"),
      );
    let fresh = false;
    if (!lane) {
      if (stuck >= this.options.stuckPerRoot)
        return refuse(new CommandFilesystemUnavailable("Command folder is still not responding"));
      lane = { root, queue: [], readers: new Set() };
      this.lanes.set(root, lane);
      fresh = true;
    }
    const bound = lane;
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.jobs,
        operation,
        resolve,
        reject,
        detached: false,
        settled,
        unlisten: quiet,
      };
      if (signal) {
        const abort = () => this.cancel(bound, job, cancelled(signal));
        signal.addEventListener("abort", abort, { once: true });
        job.unlisten = () => signal.removeEventListener("abort", abort);
      }
      bound.queue.push(job);
      if (fresh) this.admit(bound);
      else this.pump(bound);
    });
  }

  /** Gives a new lane a thread now, or queues it for one, failing at the deadline. */
  private admit(lane: Lane): void {
    const executor = this.take();
    if (executor) return this.bind(lane, executor);
    this.waiting.push(lane);
    lane.stopWaiting = this.options.timer(() => {
      const at = this.waiting.indexOf(lane);
      if (at >= 0) this.waiting.splice(at, 1);
      lane.stopWaiting = undefined;
      this.fail(lane, new CommandFilesystemUnavailable("Too many command folders are busy"));
    }, this.options.deadlineMs);
  }

  private take(): Executor | undefined {
    const reused = this.spare.pop();
    if (reused) {
      reused.stopIdle?.();
      reused.stopIdle = undefined;
      return reused;
    }
    if (this.live >= this.options.maxWorkers || this.threads() >= this.options.maxThreads)
      return undefined;
    let executor: Executor | undefined;
    const native = this.options.spawn({
      reply: (reply) => executor && this.replied(executor, reply),
      exit: (error) => executor && this.exited(executor, error),
    });
    executor = { id: ++this.executors, native };
    this.live++;
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
    while (this.waiting.length) {
      const executor = this.take();
      if (!executor) return;
      const lane = this.waiting.shift();
      if (lane) this.bind(lane, executor);
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
    const stop = this.options.timer(() => this.abandon(lane), this.options.deadlineMs);
    lane.running = { job, stop };
    executor.native.hold(true);
    executor.native.send(job.id, job.operation);
  }

  private replied(executor: Executor, reply: PosixReply): void {
    const lane = executor.gone ? undefined : executor.lane;
    const running = lane?.running;
    if (!lane || !running || running.job.id !== reply.id) return;
    running.stop();
    lane.running = undefined;
    executor.native.hold(false);
    const { job } = running;
    job.unlisten();
    const { operation } = job;
    if (operation.op === "closeDirectory") lane.readers.delete(operation.reader);
    const opened = reply.ok && typeof reply.value === "number" ? reply.value : -1;
    if (operation.op === "openDirectory" && opened > 0) lane.readers.add(opened);
    if (job.detached) {
      // Nobody will close what the abandoned caller would have: release it here, first.
      if (operation.op === "openDirectory" && opened > 0)
        lane.queue.unshift(this.internal({ op: "closeDirectory", reader: opened }));
      if ((operation.op === "open" || operation.op === "create") && opened >= 0)
        lane.queue.unshift(this.internal({ op: "closeFd", fd: opened }));
    } else if (reply.ok) job.resolve({ value: reply.value, executor: executor.id });
    else job.reject(new Error(reply.message));
    job.settled();
    this.pump(lane);
  }

  private internal(operation: PosixOperation): Job {
    return {
      id: ++this.jobs,
      operation,
      resolve: quiet,
      reject: quiet,
      detached: false,
      settled: quiet,
      unlisten: quiet,
    };
  }

  private exited(executor: Executor, error: Error): void {
    const gone = executor.gone;
    if (gone === "ended") return;
    executor.gone = "ended";
    if (gone === "draining") {
      const root = executor.root ?? "";
      const left = (this.draining.get(root) ?? 1) - 1;
      if (left > 0) this.draining.set(root, left);
      else this.draining.delete(root);
      this.drainingTotal--;
      return this.wake();
    }
    if (gone === "retired") return;
    this.live--;
    const spare = this.spare.indexOf(executor);
    if (spare >= 0) {
      this.spare.splice(spare, 1);
      executor.stopIdle?.();
    } else if (executor.lane) this.fail(executor.lane, error);
    this.wake();
  }

  /** The caller stops waiting. A running call keeps its thread and is released when it returns. */
  private cancel(lane: Lane, job: Job, error: Error): void {
    job.unlisten();
    if (lane.running?.job === job) {
      job.detached = true;
      return job.reject(error);
    }
    const at = lane.queue.indexOf(job);
    if (at < 0) return;
    lane.queue.splice(at, 1);
    job.reject(error);
    job.settled();
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
    const write = mutating.has(running.job.operation.op);
    this.fail(
      lane,
      write ? new CommandWriteOutcomeUnknown("A change to a command folder timed out") : stopped(),
      stopped(),
    );
    this.wake();
  }

  /** Every call on the lane fails, and its readers die with its executor. */
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
      running.job.settled();
    }
    for (const job of jobs) {
      job.unlisten();
      job.reject(queued);
      job.settled();
    }
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

const stopped = () => new CommandFilesystemUnavailable("Command folder stopped responding");

function cancelled(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new CommandFilesystemUnavailable("Command filesystem call cancelled");
}

/**
 * The calls of one user of command folders (one discovery, one prompt edit). Cancelling stops
 * only this owner: its queued calls fail at once and a running one is released when it returns,
 * while other owners' calls on the same roots carry on in order.
 */
export class PosixCallOwner {
  private readonly lanes: PosixLanes;
  private readonly controller = new AbortController();
  private readonly inflight = new Set<Promise<void>>();
  constructor(lanes: PosixLanes) {
    this.lanes = lanes;
  }
  run(
    root: string,
    operation: PosixOperation,
    options: { executor?: number } = {},
  ): Promise<{ value: PosixValue; executor: number }> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.inflight.add(promise);
    void promise.then(() => this.inflight.delete(promise));
    const signal = this.controller.signal;
    return this.lanes.run(root, operation, { ...options, signal, settled: resolve });
  }
  cleanup(): PosixLanes {
    return this.lanes;
  }
  cancel(): void {
    this.controller.abort(new CommandFilesystemUnavailable("Command files closed"));
  }
  /**
   * Resolves once none of this owner's calls is still on a thread: each ends by answering or at
   * its deadline, so this takes at most one deadline after `cancel`, however many roots stall.
   */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all(this.inflight);
  }
}
