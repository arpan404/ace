import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
import { encodeFrames, FrameReader } from "./rust/frames.ts";

/**
 * The reader's hard memory limit, in resident memory (RSS). ace-history peaks at 24 MiB scanning
 * the scale home and 33 MiB importing a 300 MB, 200,000-record transcript (BENCHMARKS.md); 128 MiB
 * is about four times that, room for a 1 MiB record decoded beside an import's 16 MiB page cache,
 * while a runaway is still stopped early. A kill marks what was being read in the crash ledger.
 * Polled every 100 ms.
 */
export const readerMemoryLimitMb = 128;
export const readerMemoryLimitBytes = readerMemoryLimitMb * 1024 * 1024;

export interface ReaderProcessRuntime {
  limitBytes: number;
  intervalMs: number;
  sample: ResidentSampler;
  schedule: (callback: () => void, milliseconds: number) => () => void;
  platform: NodeJS.Platform;
  /** Whether `sample` can read memory here; without it the limit is not enforced. */
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
 * ace-history (ADR 0207) as a process of its own, behind the port a worker offers: messages are
 * framed on its stdin and stdout. A watchdog holds it to `limitBytes` of resident memory and
 * kills its process group when it goes over. The group is owned like every other child
 * (process-owner), and the reader exits by itself when stdin closes or the daemon is gone, so it
 * never outlives the daemon, even one killed outright.
 */
export class ReaderProcess extends EventEmitter {
  private child: ChildProcess;
  private pid: number | undefined;
  private stopWatching: (() => void) | undefined;
  private exitCode: number | undefined;
  private failed = false;
  private readonly exited = Promise.withResolvers<number>();
  private readonly runtime: ReaderProcessRuntime;
  constructor(binary: string, options: WorkerOptions, runtime: ReaderProcessRuntime) {
    super();
    this.runtime = runtime;
    this.child = spawnReader(binary, options);
    this.listen();
    this.pid = this.child.pid;
    const pid = this.pid;
    if (pid === undefined) return;
    this.own(pid);
    this.send({ init: options.workerData });
  }
  private listen(): void {
    const deliver = (value: unknown) => {
      const fault = ReaderFault.safeParse(value).data;
      if (fault) {
        const { message, code } = fault.fault;
        this.fail(Object.assign(new Error(message), code ? { code } : {}));
        return;
      }
      this.emit("message", value);
    };
    const reader = new FrameReader();
    this.child.stdout?.on("data", (chunk: Uint8Array) => {
      reader.push(chunk);
      try {
        for (const message of reader.messages()) deliver(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        this.child.kill("SIGKILL");
      }
    });
    // A pipe closed under a write reports here, never unhandled.
    this.child.stdin?.on("error", (error) => this.fail(error));
    // For the child's whole life: every failed send or spawn reports here, never unhandled.
    this.child.on("error", (error) => {
      this.fail(error);
      // A process that never started reports no exit of its own.
      if (this.child.pid === undefined) this.finish(1);
    });
    this.child.once("exit", (code) => this.finish(code ?? 1));
  }
  private own(pid: number): void {
    const runtime = this.runtime;
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
        // A group kill refused (EPERM) still ends the reader itself and fails the import.
        try {
          killGroup(pid, "SIGKILL");
        } catch (error) {
          runtime.warn(`Could not stop the history reader's process group: ${String(error)}`);
        }
        // At once on Windows too, where the group stop is an asynchronous taskkill.
        this.child.kill("SIGKILL");
        this.fail(readerMemoryError(runtime.limitBytes));
      },
    });
  }
  /** The reader's process id, once it has started. */
  get processId(): number | undefined {
    return this.pid;
  }
  /** Sends in order; dropped once the reader has gone, as a terminated worker's port would. */
  postMessage(message: unknown): void {
    this.send(message);
  }
  /** Stops the reader (and anything in its group) and resolves once its process has exited. */
  async terminate(): Promise<number> {
    if (this.exitCode !== undefined) return this.exitCode;
    if (this.pid !== undefined) await this.stopGroup(this.pid, 1000);
    return this.exited.promise;
  }
  private send(message: unknown): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || this.exitCode !== undefined) return;
    const id = typeof message === "object" && message !== null ? Reflect.get(message, "id") : 0;
    for (const bytes of encodeFrames(message, typeof id === "number" ? id : 0)) stdin.write(bytes);
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

/** ace-history: frames on stdin and stdout, its own process group, exits when stdin closes. */
function spawnReader(path: string, options: WorkerOptions): ChildProcess {
  return spawn(path, [], {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
    env: readerEnv(options),
  });
}

function readerEnv(options: WorkerOptions): NodeJS.ProcessEnv {
  return {
    ...(typeof options.env === "object" ? options.env : process.env),
    // The daemon to watch: the reader's own parent can change if the daemon dies first.
    [readerParentVariable]: String(process.pid),
  };
}
