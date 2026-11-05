import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { WorkerOptions } from "node:worker_threads";
import { watchMemory } from "@ace/provider-kit/memory-watchdog";
import {
  killGroup,
  registerGroup,
  stopRetainedGroup,
  stopRetainedWindowsTree,
  unregisterGroup,
} from "@ace/provider-kit/process-owner";
import { residentSampler, type ResidentSampler } from "@ace/provider-kit/resident-memory";
import { ReaderFault } from "./reader-host.ts";

/**
 * The reader's hard memory limit, in resident memory (RSS). The worker it replaces had a 128 MB
 * old-generation heap plus 16 MB young generation; with the runtime, SQLite and file buffers on
 * top, that reader peaked at about 250 MB RSS on Node in the scale suite (6,000 sessions and
 * gigabyte transcripts), and the same work peaks at about 315 MB on Bun. 512 MB leaves 60%
 * headroom over the largest real peak, so a busy reader is never mistaken for a runaway one (a
 * kill marks the transcript being read as unsupported), while a runaway one is stopped long
 * before it can strain the machine. Polled every 100 ms.
 */
export const readerMemoryLimitMb = 512;
export const readerMemoryLimitBytes = readerMemoryLimitMb * 1024 * 1024;

export interface ReaderProcessRuntime {
  limitBytes: number;
  intervalMs: number;
  sample: ResidentSampler;
  schedule: (callback: () => void, milliseconds: number) => () => void;
  platform: NodeJS.Platform;
}

export const systemReaderRuntime = (): ReaderProcessRuntime => ({
  limitBytes: readerMemoryLimitBytes,
  intervalMs: 100,
  sample: residentSampler(),
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
  platform: process.platform,
});

/** The memory error in-flight history requests fail with when the watchdog stops the reader. */
export function readerMemoryError(limitBytes: number): Error {
  const mb = Math.round(limitBytes / (1024 * 1024));
  return new Error(
    `Saved conversations stopped: their reader went over its ${mb} MB memory limit and is restarting`,
  );
}

/**
 * The history reader as a process of its own, behind the same port a worker thread offers: a
 * runaway transcript can then only use up the reader's memory, never the daemon's. Bun ignores
 * a worker's resourceLimits, so a watchdog here holds the reader to `limitBytes` of resident
 * memory and kills its process group when it goes over. The group is owned like every other
 * child (process-owner), and the reader exits by itself when its channel to the daemon closes,
 * so it never outlives the daemon, even one killed outright.
 */
export class ReaderProcess extends EventEmitter {
  private child: ChildProcess;
  private pid: number | undefined;
  private stopWatching: (() => void) | undefined;
  private exitCode: number | undefined;
  private readonly exited = Promise.withResolvers<number>();
  private readonly runtime: ReaderProcessRuntime;
  constructor(entry: URL, options: WorkerOptions, runtime: ReaderProcessRuntime) {
    super();
    this.runtime = runtime;
    const windows = runtime.platform === "win32";
    this.child = fork(fileURLToPath(entry), [], {
      // Structured clone, as between threads: blob chunks stay Uint8Array.
      serialization: "advanced",
      // Its own process group (POSIX), so a stop reaches anything it starts.
      detached: !windows,
      windowsHide: true,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      // Never the daemon's own flags (watch mode, inspector). The watchdog is the one memory
      // limit on every runtime, so a worker's resourceLimits are not passed on as heap flags.
      execArgv: [...(options.execArgv ?? [])],
      env: typeof options.env === "object" ? options.env : process.env,
    });
    this.child.on("message", (value: unknown) => {
      const fault = ReaderFault.safeParse(value).data;
      if (fault) {
        const { message, code } = fault.fault;
        this.emit("error", Object.assign(new Error(message), code ? { code } : {}));
        return;
      }
      this.emit("message", value);
    });
    this.child.once("error", (error) => {
      // The process never started; nothing else will report its end.
      this.emit("error", error);
      if (this.pid === undefined) this.finish(1);
    });
    this.child.once("exit", (code) => this.finish(code ?? 1));
    this.pid = this.child.pid;
    const pid = this.pid;
    if (pid === undefined) return;
    registerGroup(
      pid,
      (graceMs) => this.stopGroup(pid, graceMs),
      { name: "history-reader" },
      () => killGroup(pid, "SIGKILL"),
    );
    this.stopWatching = watchMemory({
      pid,
      limitBytes: runtime.limitBytes,
      intervalMs: runtime.intervalMs,
      sample: runtime.sample,
      schedule: runtime.schedule,
      onExceeded: () => {
        this.stopWatching = undefined;
        killGroup(pid, "SIGKILL");
        this.emit("error", readerMemoryError(runtime.limitBytes));
      },
    });
    this.child.send({ init: options.workerData });
  }
  /** The reader's process id, once it has started. */
  get processId(): number | undefined {
    return this.pid;
  }
  /** Sends in order; dropped once the reader has gone, as a terminated worker's port would. */
  postMessage(message: unknown): void {
    // Reader requests are built from the protocol's schemas, all structured-cloneable.
    if (this.child.connected) this.child.send(message as Serializable);
  }
  /** Stops the reader (and anything in its group) and resolves with its exit code. */
  async terminate(): Promise<number> {
    if (this.exitCode !== undefined) return this.exitCode;
    if (this.pid !== undefined) await this.stopGroup(this.pid, 1000);
    return this.exited.promise;
  }
  private async stopGroup(pid: number, graceMs: number): Promise<void> {
    if (this.runtime.platform === "win32") {
      await stopRetainedWindowsTree(pid, graceMs);
      unregisterGroup(pid);
    } else await stopRetainedGroup(pid, graceMs);
  }
  private finish(code: number): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    this.stopWatching?.();
    this.stopWatching = undefined;
    if (this.pid !== undefined) unregisterGroup(this.pid);
    this.exited.resolve(code);
    this.emit("exit", code);
  }
}
