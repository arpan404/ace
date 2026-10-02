import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { killGroup, registerGroup, stopRetainedGroup, unregisterGroup } from "./process-owner.ts";
export { installShutdownHandlers } from "./process-owner.ts";

export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: "exit" | "signal" | "stopped" | "spawn-error" | "output-limit";
};
export type RawSupervisedProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<ProcessExit>;
  signal: AbortSignal;
  stop(options?: { graceMs?: number }): Promise<ProcessExit>;
};
export type SupervisedProcess = {
  stdin: Writable;
  /** Hot line streams: attach listeners immediately. Pipes drain without listeners. */
  stdout: Interface;
  stderr: Interface;
  exited: Promise<ProcessExit>;
  signal: AbortSignal;
  stop(options?: { graceMs?: number }): Promise<ProcessExit>;
};
export type SpawnOptions = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  name: string;
  /** Natural exit kills descendants by default, including agent-started dev servers. */
  killGroupOnExit?: boolean;
  /** Kill the owned group if stdout/stderr produces an oversized unterminated line. */
  maxLineBytes?: number;
  /** Stop before readline can accumulate unbounded metadata from a probe. */
  maxOutputBytes?: number;
};

/** Own a POSIX process group, including grandchildren that keep its pipes open. */
export function spawnRawSupervised(options: SpawnOptions): RawSupervisedProcess {
  if (
    options.maxOutputBytes !== undefined &&
    (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1)
  )
    throw new RangeError("Invalid maxOutputBytes");
  if (process.platform === "win32") {
    throw new Error("Process-group supervision requires POSIX; Windows needs a Job Object owner");
  }
  if (
    options.maxLineBytes !== undefined &&
    (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes < 1)
  ) {
    throw new RangeError("Invalid maxLineBytes");
  }
  const child = spawn(options.command, [...(options.args ?? [])], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  let outputBytes = 0;
  let outputLimited = false;
  const limitOutput = () => {
    if (outputLimited) return;
    outputLimited = true;
    controller.abort();
    if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  };
  // Byte guards attach before the line facade, so readline never holds an oversized line.
  if (options.maxLineBytes !== undefined) {
    const limit = options.maxLineBytes;
    for (const pipe of [child.stdout, child.stderr]) {
      let pending = 0;
      pipe.on("data", (chunk: Buffer) => {
        for (const byte of chunk) {
          pending = byte === 10 || byte === 13 ? 0 : pending + 1;
          if (pending > limit) {
            limitOutput();
            return;
          }
        }
      });
    }
  }
  const capOutput = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) limitOutput();
  };
  if (options.maxOutputBytes !== undefined) {
    child.stdout.on("data", capOutput);
    child.stderr.on("data", capOutput);
  }
  const pid = child.pid;

  let stopped = false;
  let failed = false;
  let ended = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retainedStop: Promise<ProcessExit> | undefined;
  // Pipe errors are surfaced to writers through write callbacks, never unhandled events.
  child.stdin.on("error", () => {});
  const release = () => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    if (pid !== undefined && (options.killGroupOnExit !== false || failed)) {
      killGroup(pid, "SIGKILL");
      unregisterGroup(pid);
    }
    controller.abort();
  };
  child.once("error", () => {
    failed = true;
    release();
  });
  child.once("exit", release);
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once("close", (code, signal) => {
      release();
      closed = true;
      if (timer) clearTimeout(timer);
      if (pid !== undefined && (options.killGroupOnExit !== false || failed)) unregisterGroup(pid);
      resolve({
        code,
        signal,
        reason: outputLimited
          ? "output-limit"
          : failed
            ? "spawn-error"
            : stopped
              ? "stopped"
              : signal
                ? "signal"
                : "exit",
      });
    });
  });
  const handle: RawSupervisedProcess = {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    signal: controller.signal,
    stop({ graceMs = 5_000 } = {}) {
      if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("Invalid graceMs");
      if (options.killGroupOnExit === false && pid !== undefined && !failed) {
        if (!retainedStop) {
          stopped = true;
          retainedStop = stopRetainedGroup(pid, graceMs).then(() => exited);
        }
        return retainedStop;
      }
      if (!closed && !stopped && pid !== undefined) {
        stopped = true;
        killGroup(pid, "SIGTERM");
        timer = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
      }
      return exited;
    },
  };
  if (pid !== undefined) registerGroup(pid, (graceMs) => handle.stop({ graceMs }));
  return handle;
}

/** Line-oriented facade over the same process-group owner. */
export function spawnSupervised(options: SpawnOptions): SupervisedProcess {
  const raw = spawnRawSupervised(options);
  return {
    ...raw,
    stdout: createInterface({ input: raw.stdout, crlfDelay: Infinity }),
    stderr: createInterface({ input: raw.stderr, crlfDelay: Infinity }),
  };
}

/** Bounded, read-only CLI probe. Raw output is returned only to the caller. */
export async function probeOutput(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (options.signal?.aborted) throw new Error("Probe aborted");
  const proc = spawnSupervised({ command, args, env: options.env ?? {}, name: "cli-probe" });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let failure: Error | undefined;
  const abort = () => {
    failure ??= new Error("Probe aborted");
    void proc.stop({ graceMs: 0 });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const collect = (target: "stdout" | "stderr", line: string) => {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > (options.maxBytes ?? 1_048_576)) {
      failure ??= new Error("Probe output exceeded limit");
      void proc.stop({ graceMs: 0 });
      return;
    }
    if (target === "stdout") stdout += `${line}\n`;
    else stderr += `${line}\n`;
  };
  proc.stdout.on("line", (line) => collect("stdout", line));
  proc.stderr.on("line", (line) => collect("stderr", line));
  const timer = setTimeout(() => {
    failure ??= new Error("Probe timed out");
    void proc.stop({ graceMs: 0 });
  }, options.timeoutMs ?? 30_000);
  try {
    const exit = await proc.exited;
    if (failure) throw failure;
    if (exit.reason === "spawn-error") throw new Error("Probe failed to start");
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: exit.code };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
export async function probe(command: string, args: readonly string[]): Promise<string> {
  const output = await probeOutput(command, args);
  if (output.code !== 0) throw new Error("Probe exited unsuccessfully");
  return output.stdout;
}
