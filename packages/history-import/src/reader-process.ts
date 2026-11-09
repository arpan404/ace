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
import {
  residentSampler,
  residentSamplingAvailable,
  type ResidentSampler,
} from "@ace/provider-kit/resident-memory";
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
  /** Whether `sample` can read memory here. Without it the reader gets a heap flag instead. */
  sampling: boolean;
  /** Says that the limit isn't enforced; once is enough. */
  warn: (message: string) => void;
}

export function systemReaderRuntime(): ReaderProcessRuntime {
  let warned = false;
  return {
    limitBytes: readerMemoryLimitBytes,
    intervalMs: 100,
    sample: residentSampler(),
    schedule(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    },
    platform: process.platform,
    sampling: residentSamplingAvailable(),
    warn(message) {
      if (warned) return;
      warned = true;
      process.emitWarning(message);
    },
  };
}

/** The `code` of the error a watchdog kill reports: the reader's own cause is uncertain. */
export const readerMemoryLimitCode = "history-reader-memory-limit";
/** The environment variable that names the daemon a reader process belongs to. */
export const readerParentVariable = "ACE_HISTORY_READER_PARENT";

/** The memory error in-flight history requests fail with when the watchdog stops the reader. */
export function readerMemoryError(limitBytes: number): Error {
  const mb = Math.round(limitBytes / (1024 * 1024));
  return Object.assign(
    new Error(
      `Saved conversations stopped: their reader went over its ${mb} MB memory limit and is restarting`,
    ),
    { code: readerMemoryLimitCode },
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
  private failed = false;
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
      // Never the daemon's own flags (watch mode, inspector). Where the watchdog can read
      // memory it is the one limit; where it can't (Node off Linux), Node's heap cap stands in.
      execArgv: [...(runtime.sampling ? [] : heapFlags(options)), ...(options.execArgv ?? [])],
      env: {
        ...(typeof options.env === "object" ? options.env : process.env),
        // The daemon to watch: the reader's own parent can change if the daemon dies first.
        [readerParentVariable]: String(process.pid),
      },
    });
    this.child.on("message", (value: unknown) => {
      const fault = ReaderFault.safeParse(value).data;
      if (fault) {
        const { message, code } = fault.fault;
        this.fail(Object.assign(new Error(message), code ? { code } : {}));
        return;
      }
      this.emit("message", value);
    });
    // For the child's whole life: every failed send or spawn reports here, never unhandled.
    this.child.on("error", (error) => {
      this.fail(error);
      // A process that never started reports no exit of its own.
      if (this.child.pid === undefined) this.finish(1);
    });
    this.child.once("exit", (code) => this.finish(code ?? 1));
    this.pid = this.child.pid;
    const pid = this.pid;
    if (pid === undefined) return;
    try {
      registerGroup(
        pid,
        (graceMs) => this.stopGroup(pid, graceMs),
        { name: "history-reader" },
        () => killGroup(pid, "SIGKILL"),
      );
    } catch (error) {
      // Unowned, it must not run at all.
      this.child.kill("SIGKILL");
      throw error;
    }
    if (!runtime.sampling)
      runtime.warn(
        "The history reader's memory limit is not enforced: this runtime can't read process memory here",
      );
    this.stopWatching = watchMemory({
      pid,
      limitBytes: runtime.limitBytes,
      intervalMs: runtime.intervalMs,
      sample: runtime.sample,
      schedule: runtime.schedule,
      onSampleError: (error) =>
        runtime.warn(
          `The history reader's memory limit is not enforced: ${error instanceof Error ? error.message : String(error)}`,
        ),
      onExceeded: () => {
        this.stopWatching = undefined;
        killGroup(pid, "SIGKILL");
        // At once on Windows too, where the group stop is an asynchronous taskkill.
        this.child.kill("SIGKILL");
        this.fail(readerMemoryError(runtime.limitBytes));
      },
    });
    this.send({ init: options.workerData });
  }
  /** The reader's process id, once it has started. */
  get processId(): number | undefined {
    return this.pid;
  }
  /** Sends in order; dropped once the reader has gone, as a terminated worker's port would. */
  postMessage(message: unknown): void {
    // Reader requests are built from the protocol's schemas, all structured-cloneable.
    this.send(message as Serializable);
  }
  /** Stops the reader (and anything in its group) and resolves once its process has exited. */
  async terminate(): Promise<number> {
    if (this.exitCode !== undefined) return this.exitCode;
    if (this.pid !== undefined) await this.stopGroup(this.pid, 1000);
    return this.exited.promise;
  }
  private send(message: Serializable): void {
    if (!this.child.connected) return;
    this.child.send(message, (error) => {
      if (error) this.fail(error);
    });
  }
  /** The reader's one terminal error; later ones (each failed send of a dying reader) add nothing. */
  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.emit("error", error);
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

/** Node's stand-in limit: the worker's old-generation heap size, as a flag. */
function heapFlags(options: WorkerOptions): string[] {
  const old = options.resourceLimits?.maxOldGenerationSizeMb;
  return old === undefined ? [] : [`--max-old-space-size=${old}`];
}
