import { spawn } from "node:child_process";
export { OutputLineDroppedError, type DroppedOutputLine } from "./output-line-drop.ts";
import type { DroppedOutputLine } from "./output-line-drop.ts";
export { lineReader } from "./line-reader.ts";
import type { Interface } from "node:readline";
import { lineReader } from "./line-reader.ts";
import type { OutputFlow } from "./flow-control.ts";
import type { Readable, Writable } from "node:stream";
import { byteLimit } from "./byte-limit.ts";
import { jsonElision, type ElisionLimits } from "./elision.ts";
import { outputGate, OutputLimitError } from "./output-budget.ts";
import { killGroup, registerGroup, stopRetainedGroup, unregisterGroup } from "./process-owner.ts";
import { killWindowsTree, stopRetainedWindowsTree, type WindowsKillTree } from "./process-owner.ts";
import { toWindowsCommand } from "./process-owner.ts";
import {
  createKillOnCloseJob,
  type WindowsJob,
  type WindowsJobFactory,
} from "./process-containment.ts";
import { probeOffThread, type ProbeThread } from "./probe-thread.ts";
export {
  stopOwnedGroups,
  observeProcessGroups,
  installShutdownHandlers,
  registerGroup,
  unregisterGroup,
  stopRetainedGroup,
} from "./process-owner.ts";

export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: "exit" | "signal" | "stopped" | "spawn-error" | "output-limit";
};
export type RawSupervisedProcess = {
  readonly pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<ProcessExit>;
  signal: AbortSignal;
  stop(options?: { graceMs?: number }): Promise<ProcessExit>;
};
export type SupervisedProcess = {
  readonly pid?: number;
  stdin: Writable;
  /** Hot line streams: attach listeners immediately. Pipes drain without listeners. */
  stdout: Interface;
  stderr: Interface;
  exited: Promise<ProcessExit>;
  signal: AbortSignal;
  stop(options?: { graceMs?: number }): Promise<ProcessExit>;
};
export type SpawnOptions = {
  /** Durable resource ownership brackets the native spawn, including the crash gap. */
  lease?: ProcessLease;
  outputFlow?: OutputFlow;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  name: string;
  /** Natural exit kills descendants by default, including agent-started dev servers. */
  killGroupOnExit?: boolean;
  /** UTF-8 bytes per stdout/stderr line, checked before framing. Defaults to 16 MiB. */
  maxLineBytes?: number;
  /** Platform override for the Windows branch; tests inject "win32" without a Windows host. */
  platform?: NodeJS.Platform;
  /** Whole-tree stop used on Windows instead of process-group signals. */
  windowsKillTree?: WindowsKillTree;
  /** Kernel containment for the Windows tree; an unavailable job keeps the tree stop. */
  windowsJobFactory?: WindowsJobFactory;
  /** Opt in to dropping oversized stdout lines. Stderr and total budgets still kill. */
  onStdoutLineDropped?: (line: DroppedOutputLine) => void;
  onOutputLimit?: (error: Error) => void;
  /**
   * Elide heavy JSON strings on stdout before any limit sees them, so inline images never
   * count toward `maxLineBytes` or `maxOutputBytes`. Stderr is left as written.
   */
  elideStdout?: ElisionLimits;
  /** Optional aggregate raw stdout/stderr budget, primarily for probes. */
  maxOutputBytes?: number;
};

export interface ProcessLease {
  preparing(): void;
  spawned(pid: number): void;
}

/** Spawn failure can close a pipe without emitting end. Finish the elider there too. */
function elide(input: Readable, limits: ElisionLimits): Readable {
  const elider = jsonElision(limits);
  input.once("close", () => elider.end());
  elider.once("close", () => input.destroy());
  return input.pipe(elider);
}

/** Own a POSIX process group, including grandchildren that keep its pipes open. */
function spawnOwned(options: SpawnOptions, maxLineBytes: number | undefined): RawSupervisedProcess {
  // No process groups exist on Windows; stop the whole tree with taskkill instead.
  const windows = (options.platform ?? process.platform) === "win32";
  const killTree = options.windowsKillTree ?? killWindowsTree;
  const terminate = (pid: number) => {
    if (windows) killTree(pid, false);
    else killGroup(pid, "SIGTERM");
  };
  const destroy = (pid: number) => {
    if (windows) killTree(pid, true);
    else killGroup(pid, "SIGKILL");
  };
  const stopRetained = (pid: number, graceMs: number) =>
    windows
      ? stopRetainedWindowsTree(pid, graceMs, killTree, job)
      : stopRetainedGroup(pid, graceMs);
  const maxOutputBytes =
    options.maxOutputBytes === undefined
      ? undefined
      : byteLimit(options.maxOutputBytes, "maxOutputBytes");
  options.lease?.preparing();
  const target = windows
    ? toWindowsCommand(options.command, options.args ?? [])
    : { command: options.command, args: [...(options.args ?? [])], verbatim: false };
  const child = spawn(target.command, target.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    ...(windows ? { detached: false, windowsHide: true } : { detached: true }),
    windowsVerbatimArguments: target.verbatim,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  const pid = child.pid;
  const factory = options.windowsJobFactory ?? createKillOnCloseJob;
  const job: WindowsJob | undefined = windows && pid !== undefined ? factory() : undefined;
  if (pid !== undefined) job?.assign(pid);
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
    if (pid !== undefined) destroy(pid);
    try {
      options.onOutputLimit?.(error);
    } catch {
      /* Observation cannot delay process termination. */
    }
  };
  const gateOutput = (input: Readable, dropped?: (line: DroppedOutputLine) => void): Readable => {
    if (maxLineBytes === undefined && maxOutputBytes === undefined) return input;
    const gate = outputGate(maxLineBytes, admit, failOutput, dropped);
    // Spawn failure can close a pipe without emitting end. Finish framing there too.
    input.once("close", () => gate.end());
    gate.once("close", () => input.destroy());
    return input.pipe(gate);
  };
  const stdout = gateOutput(
    options.elideStdout ? elide(child.stdout, options.elideStdout) : child.stdout,
    options.onStdoutLineDropped,
  );
  const stderr = gateOutput(child.stderr);

  let stopped = false;
  let failed = false;
  let ended = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retainedStop: Promise<ProcessExit> | undefined;
  let retainedKill: ReturnType<typeof setTimeout> | undefined;
  /** When the current stop escalates to SIGKILL; a shorter later stop moves it earlier. */
  let killAt: number | undefined;
  const shortens = (graceMs: number) => {
    const at = performance.now() + graceMs;
    if (killAt !== undefined && killAt <= at) return false;
    killAt = at;
    return true;
  };
  // Pipe errors are surfaced to writers through write callbacks, never unhandled events.
  child.stdin.on("error", () => {});
  const release = () => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    if (pid !== undefined && (options.killGroupOnExit !== false || failed)) {
      destroy(pid);
      unregisterGroup(pid);
      job?.dispose();
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
      if (pid !== undefined && (options.killGroupOnExit !== false || failed)) {
        unregisterGroup(pid);
        job?.dispose();
      }
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
    ...(pid === undefined ? {} : { pid }),
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
          killAt = performance.now() + graceMs;
          // A retained Windows tree has no group owner to release it; the stop
          // completion releases ownership and its job handle, like the POSIX path.
          const stopping = windows
            ? stopRetained(pid, graceMs).finally(() => {
                unregisterGroup(pid);
                job?.dispose();
              })
            : stopRetained(pid, graceMs);
          retainedStop = stopping.then(() => exited);
          void stopping.finally(() => clearTimeout(retainedKill));
        } else if (shortens(graceMs)) {
          // The group can outlive its leader, so this deadline survives the leader's exit.
          clearTimeout(retainedKill);
          retainedKill = setTimeout(() => destroy(pid), graceMs);
        }
        return retainedStop;
      }
      if (!closed && pid !== undefined && (!stopped || shortens(graceMs))) {
        // A later stop with a shorter grace (a daemon shutdown overtaking a polite close)
        // brings the SIGKILL forward; it never pushes one back.
        if (!stopped) terminate(pid);
        stopped = true;
        killAt ??= performance.now() + graceMs;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => destroy(pid), graceMs);
      }
      return exited;
    },
  };
  if (pid !== undefined)
    registerGroup(
      pid,
      (graceMs) => handle.stop({ graceMs }),
      {
        name: options.name,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
      () => destroy(pid),
    );
  try {
    if (pid !== undefined) options.lease?.spawned(pid);
  } catch (error) {
    // A journal failure cannot leave an unowned process running.
    if (pid !== undefined) {
      destroy(pid);
      unregisterGroup(pid);
      job?.dispose();
    }
    throw error;
  }
  return handle;
}

/** Binary bytes share the aggregate budget without imposing line framing. */
export function spawnRawSupervised(options: SpawnOptions): RawSupervisedProcess {
  return spawnOwned(options, undefined);
}

/** Bounded text bytes for callers that own their decoding/framing. */
export function spawnTextSupervised(options: SpawnOptions): RawSupervisedProcess {
  return spawnOwned(options, byteLimit(options.maxLineBytes ?? 16 * 1024 * 1024, "maxLineBytes"));
}

/** Line-oriented facade over the same bounded text-stream owner. */
export function spawnSupervised(options: SpawnOptions): SupervisedProcess {
  const raw = spawnTextSupervised(options);
  return {
    ...raw,
    stdout: lineReader(
      raw.stdout,
      options.maxLineBytes ?? 16 * 1024 * 1024,
      (error) => {
        options.onOutputLimit?.(error);
      },
      options.outputFlow,
    ),
    stderr: lineReader(
      raw.stderr,
      options.maxLineBytes ?? 16 * 1024 * 1024,
      (error) => {
        options.onOutputLimit?.(error);
      },
      options.outputFlow,
    ),
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
    /** Spawns on this thread instead of the probe worker; tests inject a fake process here. */
    spawn?: typeof spawnRawSupervised;
    schedule?: (callback: () => void, milliseconds: number) => () => void;
    thread?: ProbeThread;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const maxBytes = byteLimit(options.maxBytes ?? 1_048_576, "maxBytes");
  if (options.signal?.aborted) throw new Error("Probe aborted");
  const schedule =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
  // A spawn blocks its thread until the child starts, seconds under load: keep it off this one.
  if (!options.spawn)
    return probeOffThread(command, args, {
      timeoutMs: options.timeoutMs ?? 30_000,
      env: options.env ?? {},
      maxBytes,
      signal: options.signal,
      schedule,
      thread: options.thread,
    });
  const proc = options.spawn({
    command,
    args,
    env: options.env ?? {},
    name: "cli-probe",
    maxOutputBytes: maxBytes,
  });
  // Read-only probes never write: EOF stdin so a CLI waiting on stdin exits
  // instead of hanging until the probe timeout.
  proc.stdin.end();
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
