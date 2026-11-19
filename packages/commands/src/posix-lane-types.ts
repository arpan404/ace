import type { PosixExecutor } from "./posix-executor.ts";
import { CommandFilesystemUnavailable } from "./posix-ops.ts";
import type { PosixOperation, PosixValue } from "./posix-wire.ts";

/** One worker thread as the lanes see it. */
export interface Executor {
  id: number;
  native: PosixExecutor;
  lane?: Lane | undefined;
  /** Set once it serves no one: draining after a deadline, retired when idle, or failed. */
  gone?: "draining" | "retired" | "failed" | undefined;
  /** The root a draining thread counts against. */
  root?: string | undefined;
  /** The call sent and not yet answered. */
  inflight?: Job | undefined;
  exited: boolean;
  stopIdle?: (() => void) | undefined;
  /** Handles this thread owns, closed or not yet reported closed; they keep it on its root. */
  handles: Set<number>;
}
/** One call, queued or running. */
export interface Job {
  id: number;
  root: string;
  operation: PosixOperation;
  /** The thread that owns the handles the call names; it must run there. */
  owner?: Executor | undefined;
  resolve(result: { value: PosixValue }): void;
  reject(error: Error): void;
  /** The caller gave up while it ran; what it opened is closed, not delivered. */
  detached: boolean;
  /** The identities of the handles it names. */
  identities: string[];
  /** A change holding its identities as landing until it returns natively. */
  holding: boolean;
  unlisten(): void;
}
/** One root's queue and the thread serving it. */
export interface Lane {
  root: string;
  executor?: Executor | undefined;
  queue: Job[];
  running?: { job: Job; stop: () => void } | undefined;
  stopWaiting?: (() => void) | undefined;
}

/** A call that failed with the error a worker reported, code included. */
export class CommandCallError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.code = code;
  }
}
export const stopped = () => new CommandFilesystemUnavailable("Command folder stopped responding");
export const unfinished = () =>
  new CommandFilesystemUnavailable("An earlier change to this folder hasn't finished");
export const closedHandle = () =>
  new CommandFilesystemUnavailable("This command folder handle is no longer open");
export function cancelled(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new CommandFilesystemUnavailable("Command filesystem call cancelled");
}

let jobs = 0;
const quiet = () => {};
/** A new call; `resolve` and `reject` default to doing nothing (internal closes). */
export function newJob(
  root: string,
  operation: PosixOperation,
  owner: Executor | undefined,
  resolve: Job["resolve"] = quiet,
  reject: Job["reject"] = quiet,
): Job {
  return {
    id: ++jobs,
    root,
    operation,
    owner,
    resolve,
    reject,
    detached: false,
    identities: [],
    holding: false,
    unlisten: quiet,
  };
}

/** Why a call is refused before it is queued, if it is. */
export function admissionRefusal(call: {
  change: boolean;
  fenced: boolean;
  /** It would need a lane, and a thread, of its own. */
  newLane: boolean;
  stuck: number;
  stuckPerRoot: number;
  mayStart: boolean;
  spares: number;
}): Error | undefined {
  if (call.change && call.fenced) return unfinished();
  if (!call.newLane) return undefined;
  if (call.stuck >= call.stuckPerRoot)
    return new CommandFilesystemUnavailable("Command folder is still not responding");
  // Stuck threads may fill only the room beyond the serving threads. Once they do, no new thread
  // starts for any root, however its path is spelled; a new root takes a spare or fails at once.
  if (!call.mayStart && call.spares === 0)
    return new CommandFilesystemUnavailable("Too many command folders stopped responding");
  return undefined;
}
