import { spawn } from "node:child_process";
import {
  lowerChildPriority,
  systemChildPriority,
  type ChildPriorityPort,
} from "./child-priority.ts";
export { OutputLineDroppedError, type DroppedOutputLine } from "./output-line-drop.ts";
import type { DroppedOutputLine } from "./output-line-drop.ts";
export { lineReader } from "./line-reader.ts";
import type { Interface } from "node:readline";
import { lineReader } from "./line-reader.ts";
import type { OutputFlow } from "./flow-control.ts";
import type { Readable, Writable } from "node:stream";
import { byteLimit } from "./byte-limit.ts";
import { jsonElision, type ElisionLimits } from "./elision.ts";
import { reportBunStdinFailures } from "./bun-stdin.ts";
import { outputGate, OutputLimitError } from "./output-budget.ts";
import { admitProcess, registerGroup, signalTree, stopRetainedGroup } from "./process-owner.ts";
import { unregisterGroup } from "./process-owner.ts";
import { killWindowsTree, stopRetainedWindowsTree, type WindowsKillTree } from "./process-owner.ts";
import { windowsTreeRunning } from "./process-owner.ts";
import { toWindowsCommand } from "./process-owner.ts";
import {
  createKillOnCloseJob,
  type WindowsJob,
  type WindowsJobFactory,
} from "./process-containment.ts";
import { probeOffThread, type ProbeThread } from "./probe-thread.ts";
import { resolveProbeLaunch, resolveWithin, type ProbeLaunch } from "./probe-resolve.ts";
import { markedEnv } from "./process-marker.ts";
export {
  stopOwnedGroups,
  ownedGroupLeaders,
  onGroupOwned,
  guardGroupSignals,
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
  /**
   * How the child is lowered below the daemon's priority (`child-priority.ts`, ADR 0196); false
   * leaves it at the daemon's. Defaults to the real OS.
   */
  childPriority?: ChildPriorityPort | false;
  /**
   * Runs `run` once after `ms`; returns a cancel. Rechecks a retained Windows tree that survived
   * its stop. Defaults to an unref'd timer, so the recheck never keeps the daemon alive.
   */
  schedule?: (run: () => void, ms: number) => () => void;
  /** Opt in to dropping oversized stdout lines. Stderr and total budgets still kill. */
  onStdoutLineDropped?: (line: DroppedOutputLine) => void;
  /**
   * Opt in to dropping oversized stderr lines, for children whose stderr is diagnostics only
   * (it may carry inherited output from their own children). The total budget still kills.
   */
  onStderrLineDropped?: (line: DroppedOutputLine) => void;
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
function spawnOwned(
  options: SpawnOptions,
  maxLineBytes: number | undefined,
  /** What `options.env` is laid over: the daemon's environment, or nothing. */
  base: NodeJS.ProcessEnv = process.env,
): RawSupervisedProcess {
  // No process groups exist on Windows; stop the whole tree with taskkill instead.
  const windows = (options.platform ?? process.platform) === "win32";
  const killTree = options.windowsKillTree ?? killWindowsTree;
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
    env: markedEnv({ ...base, ...options.env }),
    ...(windows ? { detached: false, windowsHide: true } : { detached: true }),
    windowsVerbatimArguments: target.verbatim,
    stdio: ["pipe", "pipe", "pipe"],
  });
  reportBunStdinFailures(child.stdin);
  // Never throws: stops run from timers, exit listeners and voided stop() calls.
  const terminate = (pid: number) => signalTree(pid, false, windows, killTree, child);
  const destroy = (pid: number) => signalTree(pid, true, windows, killTree, child);
  const controller = new AbortController();
  const pid = child.pid;
  if (pid !== undefined && options.childPriority !== false)
    lowerChildPriority(pid, options.childPriority ?? systemChildPriority(process.platform));
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
  const stderr = gateOutput(child.stderr, options.onStderrLineDropped);

  let stopped = false;
  let failed = false;
  let ended = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retainedStop: Promise<ProcessExit> | undefined;
  let retainedKill: ReturnType<typeof setTimeout> | undefined;
  let cancelRecheck: (() => void) | undefined;
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => {
      const recheck = setTimeout(run, ms);
      recheck.unref?.();
      return () => clearTimeout(recheck);
    });
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
      // This runs in the child's exit listener, where a throw would be uncaught (and would end
      // a probe worker with every probe in it). A tree stop that cannot run, as on Windows
      // without a kernel32 binding, is reported and ownership still ends.
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
        // After a failed spawn Bun reports no signal at all, where Node reports null.
        signal: signal ?? null,
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
          // Resolves only once the tree is confirmed gone. A retained Windows tree has no group
          // owner to release it, so that confirmation releases ownership and its job handle.
          // Survivors stay owned and the stop rejects: the daemon's shutdown still ends them.
          const treeGone = () => {
            clearTimeout(retainedKill);
            cancelRecheck?.();
            if (windows) {
              unregisterGroup(pid);
              job?.dispose();
            }
          };
          retainedStop = stopRetained(pid, graceMs).then(() => {
            treeGone();
            return exited;
          });
          /*
           * Survivors keep the group owned, and later stops keep failing, until the tree is
           * confirmed gone. On Windows nothing else would ever notice that, so it is rechecked
           * with backoff; then ownership and the job end, and later stops resolve.
           */
          const recheck = (delayMs: number) => {
            cancelRecheck = schedule(() => {
              cancelRecheck = undefined;
              let running = true;
              try {
                running = windowsTreeRunning(pid, job);
              } catch {
                /* Unknown: still owned. */
              }
              if (running) return recheck(Math.min(delayMs * 2, 60_000));
              treeGone();
              retainedStop = exited;
            }, delayMs);
          };
          // stop() is often voided (abort listeners, timers). Every awaiting caller still sees
          // the failure; this only keeps it from going unheard.
          retainedStop.catch((error: unknown) => {
            process.emitWarning(`Could not stop process group ${pid}: ${String(error)}`);
            if (windows) recheck(1_000);
          });
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

/**
 * As `spawnRawSupervised`, but the child gets exactly `options.env` (and the run's owner
 * marker), nothing of the daemon's own environment: for a worker that must not see the
 * daemon's credentials or settings.
 */
export function spawnRawSupervisedExactEnv(options: SpawnOptions): RawSupervisedProcess {
  return spawnOwned(options, undefined, {});
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
export type ProbeOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Where the CLI will run, so a shim resolves for that project. Defaults to the daemon's. */
  cwd?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Spawns on this thread instead of the probe worker; tests inject a fake process here. */
  spawn?: typeof spawnRawSupervised;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
  thread?: ProbeThread;
  /** Resolves what runs, reading the filesystem; tests stand in for one that hangs. */
  resolve?: typeof resolveProbeLaunch;
};
type ProbeResult = { stdout: string; stderr: string; code: number | null };
export async function probeOutput(
  command: string,
  args: readonly string[],
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const maxBytes = byteLimit(options.maxBytes ?? 1_048_576, "maxBytes");
  if (options.signal?.aborted) throw new Error("Probe aborted");
  // Owned from the moment it is asked for, as a probe's process is: a global stop while the
  // command still resolves waits for the probe, which then starts already stopping.
  const halt = new AbortController();
  let settled: Promise<unknown> = Promise.resolve();
  const release = admitProcess(
    async () => {
      halt.abort(new Error("Probe stopped"));
      await settled;
    },
    () => halt.abort(new Error("Probe stopped")),
  );
  const running = runProbe(command, args, options, maxBytes, halt.signal);
  settled = running.catch(() => {});
  try {
    return await running;
  } finally {
    release();
  }
}
async function runProbe(
  command: string,
  args: readonly string[],
  options: ProbeOptions,
  maxBytes: number,
  halt: AbortSignal,
): Promise<ProbeResult> {
  const timer =
    options.schedule ??
    ((callback: () => void, ms: number) => {
      const timeout = setTimeout(callback, ms);
      return () => clearTimeout(timeout);
    });
  // One deadline from the probe's start: resolving what runs and running it share the timeout.
  const deadline = new AbortController();
  const cancelDeadline = timer(
    () => deadline.abort(new Error("Probe timed out")),
    options.timeoutMs ?? 30_000,
  );
  /** What each phase is given as its timer: that one deadline, never a fresh one. */
  const schedule = (callback: () => void) => {
    if (deadline.signal.aborted) {
      callback();
      return () => {};
    }
    deadline.signal.addEventListener("abort", callback, { once: true });
    return () => deadline.signal.removeEventListener("abort", callback);
  };
  try {
    return await runResolved(command, args, options, maxBytes, halt, deadline.signal, schedule);
  } finally {
    cancelDeadline();
  }
}
async function runResolved(
  command: string,
  args: readonly string[],
  options: ProbeOptions,
  maxBytes: number,
  halt: AbortSignal,
  deadline: AbortSignal,
  schedule: (callback: () => void, milliseconds: number) => () => void,
): Promise<ProbeResult> {
  // A probe only reads: what it runs never reaches a version manager's shim. Resolving reads the
  // filesystem, so it is given up on the caller's abort, a global stop or the probe's deadline,
  // even while a read under it hangs; a stop then never waits on a stalled mount.
  const asked = new AbortController();
  const ask = () => asked.abort(new Error("Probe aborted"));
  if (options.signal?.aborted) ask();
  options.signal?.addEventListener("abort", ask, { once: true });
  let launch: ProbeLaunch;
  try {
    launch = await resolveWithin(
      (signal) =>
        (options.resolve ?? resolveProbeLaunch)(
          command,
          args,
          { ...process.env, ...options.env },
          { signal, cwd: options.cwd },
        ),
      AbortSignal.any([asked.signal, halt, deadline]),
    );
  } finally {
    options.signal?.removeEventListener("abort", ask);
  }
  // A spawn blocks its thread until the child starts, seconds under load: keep it off this one.
  if (!options.spawn)
    return probeOffThread(launch.command, launch.args, {
      timeoutMs: options.timeoutMs ?? 30_000,
      env: launch.env,
      cwd: options.cwd,
      maxBytes,
      signal: options.signal,
      schedule,
      thread: options.thread,
      halt,
    });
  const proc = options.spawn({
    command: launch.command,
    args: launch.args,
    env: launch.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
      // The awaiting caller reports the probe failure; stop() warns a surviving tree itself.
      void proc.stop({ graceMs: 0 }).catch(() => {});
      return;
    }
    target.push(chunk);
  };
  proc.stdout.on("data", (chunk: unknown) => collect(stdout, chunk));
  proc.stderr.on("data", (chunk: unknown) => collect(stderr, chunk));
  const abort = () => {
    failure ??= new Error("Probe aborted");
    // The awaiting caller reports the probe failure; stop() warns a surviving tree itself.
    void proc.stop({ graceMs: 0 }).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  // A global stop ends the process; what it exited with is still the probe's answer.
  const stopped = () => void proc.stop({ graceMs: 0 }).catch(() => {});
  halt.addEventListener("abort", stopped, { once: true });
  if (halt.aborted) stopped();
  const cancel = schedule(() => {
    failure ??= new Error("Probe timed out");
    // The awaiting caller reports the probe failure; stop() warns a surviving tree itself.
    void proc.stop({ graceMs: 0 }).catch(() => {});
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
    halt.removeEventListener("abort", stopped);
  }
}
export async function probe(command: string, args: readonly string[]): Promise<string> {
  const output = await probeOutput(command, args);
  if (output.code !== 0) throw new Error("Probe exited unsuccessfully");
  return output.stdout;
}
export { spawnInteractive, type InteractiveProcess } from "./process-interactive.ts";
export { toWindowsCommand, type WindowsCommand } from "./process-owner.ts";
export { createProbeThread, type ProbeThread } from "./probe-thread.ts";
