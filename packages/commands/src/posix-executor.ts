import type { PosixOperation, PosixReply } from "./posix-wire.ts";

/** One thread that runs native calls one at a time, in the order they are sent. */
export interface PosixExecutor {
  send(id: number, operation: PosixOperation): void;
  /** Whether the executor keeps the process alive; true only while a call is running. */
  hold(busy: boolean): void;
  /**
   * Stop handing it work. Once its current call returns, the thread closes every descriptor and
   * stream it owns, then exits. It must never keep the process alive afterwards.
   */
  drain(): void;
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
