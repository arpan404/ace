import type { PosixOperation, PosixReply } from "./posix-wire.ts";

export type PosixValue = number | string | null;

/** One thread that runs native calls one at a time, in the order they are sent. */
export interface PosixExecutor {
  send(id: number, operation: PosixOperation): void;
  /** Whether the executor keeps the process alive; true only while a call is running. */
  hold(busy: boolean): void;
  terminate(): void;
}
export interface PosixExecutorEvents {
  reply(reply: PosixReply): void;
  /** The thread has stopped. A terminated thread blocked in a call stops only once it returns. */
  exit(error: Error): void;
}
export type SpawnPosixExecutor = (events: PosixExecutorEvents) => PosixExecutor;
/** Starts a timer and returns its cancel. */
export type StartTimer = (run: () => void, ms: number) => () => void;

export interface PosixLaneOptions {
  spawn: SpawnPosixExecutor;
  timer: StartTimer;
  /** How long one native call may run before its thread is abandoned. */
  deadlineMs: number;
  /** How long a spare thread waits for work before it is terminated. */
  idleMs: number;
  /** Idle threads kept for the next root. */
  spares: number;
  /** Abandoned threads a root may have still blocked before its calls fail at once. */
  stuckPerRoot: number;
}

/** A command folder's calls were abandoned: it stopped responding, or the call was cancelled. */
export class CommandFilesystemUnavailable extends Error {}

interface Executor {
  id: number;
  native: PosixExecutor;
  /** The lane it is bound to, if any. */
  lane?: Lane | undefined;
  /** Set once abandoned: the root whose stuck count it holds until its thread stops. */
  stuckRoot?: string;
  stopIdle?: (() => void) | undefined;
  ended: boolean;
}
interface Job {
  id: number;
  operation: PosixOperation;
  resolve(result: { value: PosixValue; executor: number }): void;
  reject(error: Error): void;
  unlisten(): void;
}
interface Lane {
  root: string;
  executor: Executor;
  queue: Job[];
  running?: { job: Job; stop: () => void } | undefined;
  /** Directory streams open on this executor; they keep it bound to the root. */
  readers: Set<number>;
}

const stopped = () => new CommandFilesystemUnavailable("Command folder stopped responding");

/**
 * Native calls, one lane per root. A lane owns one executor while it has work or open readers,
 * so a call blocked under one root (a dead network mount, a cloud placeholder) never delays
 * another root. A call that outlives its deadline, or is cancelled while running, abandons its
 * executor: the thread is terminated and never reused, the root's queued calls and readers fail,
 * and the root's next call starts on a fresh executor.
 */
export class PosixLanes {
  private readonly options: PosixLaneOptions;
  private readonly lanes = new Map<string, Lane>();
  private readonly spare: Executor[] = [];
  private readonly stuck = new Map<string, number>();
  private executors = 0;
  private jobs = 0;
  constructor(options: PosixLaneOptions) {
    this.options = options;
  }

  /**
   * Runs `operation` on `root`'s lane. With `executor`, the call belongs to state that lives in
   * that executor (a directory stream) and fails if the executor was abandoned.
   */
  run(
    root: string,
    operation: PosixOperation,
    options: { executor?: number; signal?: AbortSignal } = {},
  ): Promise<{ value: PosixValue; executor: number }> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(cancelled(signal));
    let lane = this.lanes.get(root);
    if (options.executor !== undefined && lane?.executor.id !== options.executor)
      return Promise.reject(new CommandFilesystemUnavailable("Directory reader was abandoned"));
    if (!lane) {
      if ((this.stuck.get(root) ?? 0) >= this.options.stuckPerRoot)
        return Promise.reject(
          new CommandFilesystemUnavailable("Command folder is still not responding"),
        );
      lane = { root, executor: this.take(), queue: [], readers: new Set() };
      lane.executor.lane = lane;
      this.lanes.set(root, lane);
    }
    const bound = lane;
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.jobs, operation, resolve, reject, unlisten: () => {} };
      if (signal) {
        const abort = () => this.cancel(bound, job, cancelled(signal));
        signal.addEventListener("abort", abort, { once: true });
        job.unlisten = () => signal.removeEventListener("abort", abort);
      }
      bound.queue.push(job);
      this.pump(bound);
    });
  }

  private take(): Executor {
    const reused = this.spare.pop();
    if (reused) {
      reused.stopIdle?.();
      reused.stopIdle = undefined;
      return reused;
    }
    let executor: Executor | undefined;
    const native = this.options.spawn({
      reply: (reply) => executor && this.replied(executor, reply),
      exit: (error) => executor && this.exited(executor, error),
    });
    executor = { id: ++this.executors, native, ended: false };
    native.hold(false);
    return executor;
  }

  private pump(lane: Lane): void {
    if (lane.running) return;
    const job = lane.queue.shift();
    if (!job) {
      if (lane.readers.size === 0) this.release(lane);
      return;
    }
    const stop = this.options.timer(() => this.abandon(lane, stopped()), this.options.deadlineMs);
    lane.running = { job, stop };
    lane.executor.native.hold(true);
    lane.executor.native.send(job.id, job.operation);
  }

  private replied(executor: Executor, reply: PosixReply): void {
    const lane = executor.lane;
    const running = lane?.running;
    if (!lane || !running || running.job.id !== reply.id) return;
    running.stop();
    lane.running = undefined;
    executor.native.hold(false);
    const { job } = running;
    job.unlisten();
    const { operation } = job;
    if (operation.op === "closeDirectory") lane.readers.delete(operation.reader);
    if (reply.ok) {
      if (operation.op === "openDirectory" && typeof reply.value === "number" && reply.value > 0)
        lane.readers.add(reply.value);
      job.resolve({ value: reply.value, executor: executor.id });
    } else job.reject(new Error(reply.message));
    this.pump(lane);
  }

  private exited(executor: Executor, error: Error): void {
    if (executor.ended) return;
    executor.ended = true;
    const root = executor.stuckRoot;
    if (root !== undefined) {
      const left = (this.stuck.get(root) ?? 1) - 1;
      if (left > 0) this.stuck.set(root, left);
      else this.stuck.delete(root);
      return;
    }
    const spare = this.spare.indexOf(executor);
    if (spare >= 0) {
      this.spare.splice(spare, 1);
      executor.stopIdle?.();
      return;
    }
    if (executor.lane) this.fail(executor.lane, error);
  }

  private cancel(lane: Lane, job: Job, error: Error): void {
    if (lane.running?.job === job) return this.abandon(lane, error);
    const at = lane.queue.indexOf(job);
    if (at < 0) return;
    lane.queue.splice(at, 1);
    job.reject(error);
    if (!lane.running && lane.queue.length === 0 && lane.readers.size === 0) this.release(lane);
  }

  /**
   * The running call never came back, or was cancelled: its thread is terminated and never handed
   * work again. Descriptors and streams it holds stay with it; nothing else closes or reuses them.
   */
  private abandon(lane: Lane, error: Error): void {
    const { executor } = lane;
    executor.stuckRoot = lane.root;
    this.stuck.set(lane.root, (this.stuck.get(lane.root) ?? 0) + 1);
    executor.native.hold(false);
    executor.native.terminate();
    this.fail(lane, error, stopped());
  }

  /** Every call on the lane fails, and its readers die with its executor. */
  private fail(lane: Lane, error: Error, queued: Error = error): void {
    this.unbind(lane);
    const running = lane.running;
    lane.running = undefined;
    const jobs = lane.queue;
    lane.queue = [];
    lane.readers.clear();
    if (running) {
      running.stop();
      running.job.unlisten();
      running.job.reject(error);
    }
    for (const job of jobs) {
      job.unlisten();
      job.reject(queued);
    }
  }

  /** An idle lane gives its executor back: kept as a spare, or terminated. */
  private release(lane: Lane): void {
    this.unbind(lane);
    const { executor } = lane;
    if (executor.ended) return;
    if (this.spare.length >= this.options.spares) return executor.native.terminate();
    this.spare.push(executor);
    executor.stopIdle = this.options.timer(() => {
      const at = this.spare.indexOf(executor);
      if (at < 0) return;
      this.spare.splice(at, 1);
      executor.native.terminate();
    }, this.options.idleMs);
  }

  private unbind(lane: Lane): void {
    if (this.lanes.get(lane.root) === lane) this.lanes.delete(lane.root);
    if (lane.executor.lane === lane) lane.executor.lane = undefined;
  }
}

function cancelled(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new CommandFilesystemUnavailable("Command filesystem call cancelled");
}
