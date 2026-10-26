import { fileURLToPath } from "node:url";
import { accessSync, constants } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { constants as osConstants, tmpdir } from "node:os";
import { spawn } from "node-pty";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";
import { createRetainedJob, type RetainedJob } from "@ace/provider-kit/process-containment";
import type { ExitStatus, OpenTerminalOptions } from "./types.ts";
import { terminalEnvironment } from "./shell.ts";
import { decodeBytes, decodeExit } from "./decode.ts";
import { sessionOwnership } from "./ownership.ts";
import type { ProcessControl, ShutdownScheduler } from "./ownership.ts";
import { createProcessTable } from "./process-table.ts";
import { createGroupLease } from "./group-lease.ts";
import type { GroupLease } from "./group-lease.ts";

export interface PtyBackend {
  readonly pid: number;
  /** Ownership can outlive shell exit until all retained groups are drained. */
  readonly ownsProcesses?: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (bytes: Buffer) => void): () => void;
  onExit(listener: (status: ExitStatus | Error) => void): () => void;
  kill(signal: NodeJS.Signals): Promise<void>;
  close(graceMs: number): Promise<void>;
}
export interface BackendContext {
  owner: string;
  scheduler: ShutdownScheduler;
}
export type BackendFactory = (
  options: OpenTerminalOptions,
  shell: string,
  context: BackendContext,
) => PtyBackend;

export interface NativePty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (input: unknown) => void): { dispose(): void };
  onExit(listener: (input: unknown) => void): { dispose(): void };
}
export interface PosixPorts {
  spawn: (shell: string, args: string[], options: Parameters<typeof spawn>[2]) => NativePty;
  processes: ProcessControl;
  createLease?: () => GroupLease;
}

export const shutdownScheduler: ShutdownScheduler = {
  now: () => performance.now(),
  delay: async (ms) => {
    await setTimeout(ms);
  },
};

export { resolveShell } from "./shell.ts";
export type { ShellSelectionPorts, ShellSelectionEnv } from "./shell.ts";

/** Output and exit, decoded the same way for every backend. */
function streams(pty: NativePty, onExited: () => void) {
  return {
    onData(listener: (bytes: Buffer) => void) {
      // ConPTY delivers utf8-decoded strings of whole code points; POSIX delivers raw bytes.
      const subscription = pty.onData((input) =>
        listener(typeof input === "string" ? Buffer.from(input, "utf8") : decodeBytes(input)),
      );
      return () => subscription.dispose();
    },
    onExit(listener: (status: ExitStatus | Error) => void) {
      const subscription = pty.onExit((input) => {
        onExited();
        let status: ExitStatus | Error;
        try {
          status = decodeExit(input);
        } catch (error) {
          status = error instanceof Error ? error : new Error("Invalid native exit");
        }
        listener(status);
      });
      return () => subscription.dispose();
    },
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `sleep` for the terminal launcher, by absolute path: the terminal's environment may carry
 * any PATH (or none), and NixOS has no `/bin/sleep`, only its system profile's.
 */
export function resolveSleep(executable: (path: string) => boolean = isExecutable) {
  for (const candidate of ["/bin/sleep", "/usr/bin/sleep", "/run/current-system/sw/bin/sleep"])
    if (executable(candidate)) return candidate;
  return "sleep";
}

/** Each manager gets its own I/O context; overlapping shutdowns share a ps read. */
export function createPosixBackendFactory(
  ports?: PosixPorts,
  leaseRoot = tmpdir(),
): BackendFactory {
  const read = createProcessTable();
  return (options, shell, context) => {
    if (!ports && process.platform === "win32")
      throw new Error("Windows terminals use the ConPTY backend");
    const env = terminalEnvironment(process.env, options.env, process.platform);
    assertTestEnvironmentIsolation(env);
    const lease = ports?.createLease?.() ?? createGroupLease(leaseRoot, context.scheduler);
    const keeper = fileURLToPath(new URL("../native/group-keeper", import.meta.url));
    if (!ports?.createLease) {
      try {
        accessSync(keeper, constants.X_OK);
      } catch (error) {
        lease.dispose();
        throw new Error("Terminal guardian is not built; run bun install at packaging/merge", {
          cause: error,
        });
      }
    }
    const ignored = [...new Set(Object.values(osConstants.signals))]
      .filter(
        (signal) =>
          signal !== osConstants.signals.SIGKILL && signal !== osConstants.signals.SIGSTOP,
      )
      .join(" ");
    // The helper retains the ORIGINAL group ID, which cannot be reused while a
    // member remains. It ignores catchable signals and cleans the session on FIFO EOF.
    const launcher = `trap '' ${ignored}; "$3" "$1" "$2" >/dev/null 2>&1 & keeper=$!; while [ ! -f "$2" ]; do kill -0 "$keeper" 2>/dev/null || exit 1; '${resolveSleep()}' 0.01; done; trap - ${ignored}; shift 3; exec "$@"`;
    const loginArgs = options.args ?? ["-l", "-i"];
    let pty: NativePty;
    try {
      pty = (ports?.spawn ?? spawn)(
        "/bin/sh",
        ["-c", launcher, "ace-terminal", lease.path, lease.readyPath, keeper, shell, ...loginArgs],
        {
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          name: "xterm-256color",
          env,
          encoding: null,
          handleFlowControl: false,
        },
      );
    } catch (error) {
      lease.dispose();
      throw error;
    }
    let exited = false;
    let leaseReleaseRequested = false;
    let ownershipComplete = false;
    const base: ProcessControl = ports?.processes ?? {
      async read() {
        const deadline = context.scheduler.now() + 5000;
        for (let attempt = 0; attempt <= 128; attempt++) {
          if (lease.ready() || exited) break;
          if (attempt === 128 || context.scheduler.now() >= deadline)
            throw new Error("Terminal ownership lease did not start");
          await context.scheduler.delay(0);
        }
        if (!lease.ready()) return []; // The launcher exited before running user code.
        if (!leaseReleaseRequested && !lease.alive())
          throw new Error("Terminal ownership lease was lost");
        const rows = await read();
        // Once reaped, a new live leader with this ID belongs to a new session.
        const reused =
          exited && rows.some((row) => row.pid === pty.pid && !row.state.startsWith("Z"));
        return rows.map((row) => ({
          pid: row.pid,
          group: row.group,
          state: row.state,
          owner: !reused && row.session === pty.pid ? context.owner : null,
        }));
      },
      signal: (group, signal) => {
        process.kill(-group, signal);
      },
    };
    const control: ProcessControl = {
      read: () => base.read(),
      signalOwned: (group, signal) => {
        const sent =
          ports?.processes.signalOwned?.(group, signal) ?? lease.signalOwned?.(group, signal);
        return sent ?? Promise.reject(new Error("Missing atomic session-group signaling boundary"));
      },
      stopShell() {
        if (exited || leaseReleaseRequested || !lease.alive()) return;
        if (ports) {
          ports.processes.stopShell?.();
          return;
        }
        try {
          // The helper reserves this original group ID, so the shell PID cannot
          // be recycled while leased. Do not STOP the helper along with it.
          process.kill(pty.pid, "SIGSTOP");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
          throw error;
        }
      },
      resumeLease() {
        if (!leaseReleaseRequested && lease.alive()) base.signal(pty.pid, "SIGCONT");
      },
      signal(group, signal) {
        base.signal(group, signal);
        if (group === pty.pid && signal === "SIGKILL") leaseReleaseRequested = true;
      },
    };
    const ownership = sessionOwnership(context.owner, control, context.scheduler, pty.pid);
    return {
      pid: pty.pid,
      get ownsProcesses() {
        return !ownershipComplete;
      },
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      ...streams(pty, () => {
        exited = true;
      }),
      kill: async (signal) => {
        await ownership.kill(signal);
        if (signal === "SIGKILL") {
          lease.dispose();
          ownershipComplete = true;
        }
      },
      close: async (graceMs) => {
        await ownership.close(graceMs);
        lease.dispose();
        ownershipComplete = true;
      },
    };
  };
}

export interface ConptyNative extends NativePty {
  kill(): void;
}
export interface ConptyPorts {
  spawn?: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => ConptyNative;
  /** Strict kernel containment. Every failure throws; there is no fallback. */
  createJob?: () => RetainedJob;
}

/**
 * ConPTY backend for Windows. The selected shell runs directly under ConPTY (`useConptyDll`,
 * the shipped conpty.dll) inside a kill-on-close Job Object, which takes the place of the POSIX
 * session lease: `terminate()` stops the tree and `activeCount()` is the only liveness source.
 * No POSIX signals, `ps` table or PID kills are used. The dll kill path closes the
 * pseudoconsole and terminates the exact shell handle, so there is no PID-reuse hazard (node-pty
 * 1.1.0 `PtyKill`: `ConptyClosePseudoConsole` plus `TerminateProcess(hShell, 1)`).
 *
 * Containment race: node-pty starts the shell with a plain, non-suspended `CreateProcessW`
 * inside `spawn()` and returns its pid, and the shell joins the job synchronously right after,
 * before this event-loop turn ends. Only a process the shell starts within that window could
 * escape. A shell can't start one that fast: pwsh and powershell load .NET first, and cmd.exe
 * reads its AutoRun key first. node-pty has no suspended start, and the earlier alternative, a
 * Node gate that started the shell only after joining, cost a Node process and temp files per
 * terminal.
 *
 * Ownership outlives shell exit until `close` confirms `activeCount() === 0` and disposes the
 * job; shell exit alone never completes it.
 */
export function createConptyBackendFactory(ports: ConptyPorts = {}): BackendFactory {
  const spawnNative = ports.spawn ?? spawn;
  const createJob = ports.createJob ?? (() => createRetainedJob());
  return (options, shell, context) => {
    const env = terminalEnvironment(process.env, options.env, "win32");
    assertTestEnvironmentIsolation(env);
    const job = createJob();
    // An uncontained shell never runs on: stop its exact handle, then release the job.
    const abandon = (error: unknown, pty?: ConptyNative): never => {
      try {
        pty?.kill();
      } catch {
        // The admission failure stays the cause.
      }
      const failures: unknown[] = [error];
      try {
        job.dispose();
      } catch (disposal) {
        failures.push(disposal);
      }
      if (failures.length > 1)
        throw new AggregateError(failures, "Windows terminal containment failed", { cause: error });
      throw error;
    };
    let pty: ConptyNative;
    try {
      pty = spawnNative(shell, options.args ?? [], {
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        name: "xterm-256color",
        env,
        encoding: null,
        handleFlowControl: false,
        useConpty: true,
        useConptyDll: true,
      });
    } catch (error) {
      return abandon(error);
    }
    try {
      job.assign(pty.pid);
    } catch (error) {
      return abandon(error, pty);
    }
    let ownershipComplete = false;
    const { scheduler } = context;

    async function pollZero(): Promise<void> {
      const deadline = scheduler.now() + 1000;
      for (let sweep = 0; sweep < 32; sweep++) {
        if (job.activeCount() === 0) return;
        if (scheduler.now() >= deadline) break;
        await scheduler.delay(0);
      }
      if (job.activeCount() === 0) return;
      throw new Error("Terminal processes survived bounded shutdown");
    }

    async function escalate(): Promise<void> {
      if (ownershipComplete) return;
      try {
        job.terminate();
      } catch (error) {
        // A job that already emptied cannot be terminated; that is still a stopped tree.
        if (job.activeCount() !== 0) throw error;
      }
      await pollZero();
      // A disposal failure retains ownership for retry; only a clean dispose completes it.
      job.dispose();
      ownershipComplete = true;
      try {
        // Pseudoconsole teardown only; the job already stopped the tree.
        pty.kill();
      } catch {
        // The exit event still arrives through the native exit callback.
      }
    }

    return {
      pid: pty.pid,
      get ownsProcesses() {
        return !ownershipComplete;
      },
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      ...streams(pty, () => {}),
      kill: async (signal) => {
        if (ownershipComplete) return;
        // Windows has no POSIX signals and no graceful stop: anything but SIGKILL is an error,
        // so callers use close() instead of receiving a force-kill dressed as grace.
        if (signal !== "SIGKILL")
          throw new Error("Windows terminals do not support POSIX signals; use close()");
        await escalate();
      },
      close: async (graceMs) => {
        if (ownershipComplete) return;
        await scheduler.delay(graceMs);
        await escalate();
      },
    };
  };
}

/** The terminal backend for this OS: a POSIX pty in its own leased session, or ConPTY in a job. */
export function createBackendFactory(platform: NodeJS.Platform = process.platform): BackendFactory {
  return platform === "win32" ? createConptyBackendFactory() : createPosixBackendFactory();
}
