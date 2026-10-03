import { spawn } from "node:child_process";
export { lineReader } from "./line-reader.ts";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { byteLimit } from "./byte-limit.ts";
import { outputGate, OutputLimitError } from "./output-budget.ts";
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
  /** UTF-8 bytes per stdout/stderr line, checked before framing. Defaults to 16 MiB. */
  maxLineBytes?: number;
  onOutputLimit?: (error: Error) => void;
  /** Optional aggregate raw stdout/stderr budget, primarily for probes. */
  maxOutputBytes?: number;
};

/** Own a POSIX process group, including grandchildren that keep its pipes open. */
function spawnOwned(options: SpawnOptions, maxLineBytes: number | undefined): RawSupervisedProcess {
  if (process.platform === "win32") {
    throw new Error("Process-group supervision requires POSIX; Windows needs a Job Object owner");
  }
  const maxOutputBytes =
    options.maxOutputBytes === undefined
      ? undefined
      : byteLimit(options.maxOutputBytes, "maxOutputBytes");
  const child = spawn(options.command, [...(options.args ?? [])], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  const pid = child.pid;
  let outputBytes = 0;
  let outputLimited = false;
  const admit = (bytes: number) => {
    if (maxOutputBytes === undefined) return true;
    outputBytes += bytes;
    return outputBytes <= maxOutputBytes;
  };
  const failOutput = (error: Error) => {
    outputLimited = true;
    controller.abort(error);
    if (pid !== undefined) killGroup(pid, "SIGKILL");
    try {
      options.onOutputLimit?.(error);
    } catch {
      /* Observation cannot delay process termination. */
    }
  };
  const gateOutput = (input: Readable): Readable => {
    if (maxLineBytes === undefined && maxOutputBytes === undefined) return input;
    const gate = outputGate(maxLineBytes, admit, failOutput);
    // Spawn failure can close a pipe without emitting end. Finish framing there too.
    input.once("close", () => gate.end());
    gate.once("close", () => input.destroy());
    return input.pipe(gate);
  };
  const stdout = gateOutput(child.stdout);
  const stderr = gateOutput(child.stderr);

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
    stdout,
    stderr,
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

/** Raw bytes share the aggregate budget without imposing line framing on binary data. */
export function spawnRawSupervised(options: SpawnOptions): RawSupervisedProcess {
  return spawnOwned(
    options,
    options.maxLineBytes === undefined
      ? undefined
      : byteLimit(options.maxLineBytes, "maxLineBytes"),
  );
}

/** Line-oriented facade over the same process-group owner. */
export function spawnSupervised(options: SpawnOptions): SupervisedProcess {
  const maxLineBytes = byteLimit(options.maxLineBytes ?? 16 * 1024 * 1024, "maxLineBytes");
  const raw = spawnOwned(options, maxLineBytes);
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
    spawn?: typeof spawnRawSupervised;
    schedule?: (callback: () => void, milliseconds: number) => () => void;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const maxBytes = byteLimit(options.maxBytes ?? 1_048_576, "maxBytes");
  if (options.signal?.aborted) throw new Error("Probe aborted");
  const proc = (options.spawn ?? spawnRawSupervised)({
    command,
    args,
    env: options.env ?? {},
    name: "cli-probe",
    maxOutputBytes: maxBytes,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let failure: Error | undefined;
  const collect = (target: Buffer[], chunk: unknown) => {
    if (!Buffer.isBuffer(chunk)) {
      failure ??= new Error("Invalid probe output chunk");
      void proc.stop({ graceMs: 0 });
      return;
    }
    target.push(chunk);
  };
  proc.stdout.on("data", (chunk: unknown) => collect(stdout, chunk));
  proc.stderr.on("data", (chunk: unknown) => collect(stderr, chunk));
  const abort = () => {
    failure ??= new Error("Probe aborted");
    void proc.stop({ graceMs: 0 });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  const cancel = schedule(() => {
    failure ??= new Error("Probe timed out");
    void proc.stop({ graceMs: 0 });
  }, options.timeoutMs ?? 30_000);
  try {
    const exit = await proc.exited;
    if (failure) throw failure;
    if (proc.signal.reason instanceof OutputLimitError) throw proc.signal.reason;
    if (exit.reason === "output-limit") throw new OutputLimitError("Probe output exceeded limit");
    if (exit.reason === "spawn-error") throw new Error("Probe failed to start");
    return {
      stdout: Buffer.concat(stdout).toString().trim(),
      stderr: Buffer.concat(stderr).toString().trim(),
      code: exit.code,
    };
  } finally {
    cancel();
    options.signal?.removeEventListener("abort", abort);
  }
}
export async function probe(command: string, args: readonly string[]): Promise<string> {
  const output = await probeOutput(command, args);
  if (output.code !== 0) throw new Error("Probe exited unsuccessfully");
  return output.stdout;
}
export { spawnInteractive, type InteractiveProcess } from "./process-interactive.ts";
