import { fileURLToPath } from "node:url";
import { accessSync, constants } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { constants as osConstants, tmpdir, userInfo } from "node:os";
import { spawn } from "node-pty";
import { win32 } from "node:path";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";
import { createRetainedJob, type RetainedJob } from "@ace/provider-kit/process-containment";
import { findWindowsExecutableSync } from "@ace/provider-kit/discovery";
import { windowsCmdLine } from "@ace/provider-kit/process-owner";
import type { ExitStatus, OpenTerminalOptions } from "./types.ts";
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

/** What shell selection reads from the machine; tests substitute each one. */
export interface ShellSelectionPorts {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly exists?: ((path: string) => boolean) | undefined;
  /**
   * The account's login shell (`os.userInfo().shell`); null where the OS doesn't say. Defaults
   * to the real account only when `env` is the real environment too.
   */
  readonly accountShell?: (() => string | null) | undefined;
  /** Windows only; defaults to the host. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Windows only: PATH/PATHEXT lookup for pwsh and powershell. */
  readonly findExecutable?:
    | ((command: string, env: NodeJS.ProcessEnv) => string | undefined)
    | undefined;
}

function systemAccountShell(): string | null {
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
}

// Accounts that may not log in name these instead of a shell.
const refusing = /\/(?:nologin|false)$/;

/**
 * `$SHELL` (the session's choice), then the account's login shell (a daemon started by systemd
 * or launchd may have no `$SHELL`) unless it refuses logins, then the first of `/bin/zsh`,
 * `/bin/bash` and `/bin/sh` that is installed.
 */
export function resolveShell(shell?: string, ports?: ShellSelectionPorts): string {
  if (shell !== undefined) return shell;
  if ((ports?.platform ?? process.platform) === "win32") return resolveWindowsShell(ports);
  const env = ports?.env ?? process.env;
  const exists = ports?.exists ?? isExecutable;
  if (env.SHELL) return env.SHELL;
  const accountShell = ports?.accountShell ?? (ports?.env ? () => null : systemAccountShell);
  const account = accountShell();
  if (account && !refusing.test(account) && exists(account)) return account;
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (exists(candidate)) return candidate;
  }
  throw new Error("No login shell found");
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
    if (process.platform === "win32") throw new Error("Terminal service currently requires POSIX");
    const environment: Record<string, string | undefined> = {
      ...process.env,
      ...options.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    // A daemon started outside a terminal (launchd, a desktop app) inherits no locale, and a
    // shell in the C locale mangles typed UTF-8. Terminal apps set one; so does ace, when unset.
    if (!environment.LC_ALL && !environment.LC_CTYPE && !environment.LANG)
      environment.LC_CTYPE = "C.UTF-8";
    // node-pty stringifies undefined as "undefined". Preserve explicit environment masks.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment))
      if (value !== undefined) env[key] = value;
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
      onData(listener) {
        const subscription = pty.onData((input) => listener(decodeBytes(input)));
        return () => subscription.dispose();
      },
      onExit(listener) {
        const subscription = pty.onExit((input) => {
          exited = true;
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

// Windows below: shell order, a case-insensitive environment, and the ConPTY backend.

/** The value of a Windows env key, matched case-insensitively; empty counts as unset. */
function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === name && env[candidate],
  );
  return key === undefined ? undefined : env[key];
}

/**
 * Windows never reads `$SHELL`: pwsh, then powershell, then `%ComSpec%`, then
 * `%SystemRoot%\System32\cmd.exe`, where SystemRoot must be drive-absolute so the fallback
 * never depends on the cwd.
 */
function resolveWindowsShell(ports?: ShellSelectionPorts): string {
  const env = ports?.env ?? process.env;
  const find = ports?.findExecutable ?? findWindowsExecutableSync;
  for (const candidate of ["pwsh", "powershell"]) {
    const found = find(candidate, { ...env });
    if (found) return found;
  }
  const comSpec = windowsEnvValue(env, "comspec");
  if (comSpec !== undefined) return comSpec;
  const systemRoot = windowsEnvValue(env, "systemroot");
  if (systemRoot && /^[A-Za-z]:[\\/]/.test(systemRoot)) {
    const cmd = win32.join(systemRoot, "System32", "cmd.exe");
    if ((ports?.exists ?? isExecutable)(cmd)) return cmd;
  }
  throw new Error("No login shell found");
}

/**
 * The shell's environment on Windows, where keys are case-insensitive: a later key wins
 * regardless of spelling, `undefined` removes every spelling, and terminal colors are enforced.
 * Unset values are dropped because node-pty would stringify them as "undefined".
 */
function windowsTerminalEnv(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  const merged = [process.env, overrides ?? {}, { TERM: "xterm-256color", COLORTERM: "truecolor" }];
  for (const layer of merged)
    for (const [key, value] of Object.entries(layer)) {
      for (const prior of Object.keys(env))
        if (prior.toLowerCase() === key.toLowerCase()) delete env[prior];
      if (value !== undefined) env[key] = value;
    }
  return env;
}

export interface ConptyNative extends NativePty {
  kill(): void;
}

/** The pipe a gated Windows shell waits on until it is inside its job. */
export interface StartupGate {
  readonly path: string;
  /** Lets the waiting launcher start the shell; only called once it is contained. */
  open(): void;
  close(): void;
}

/**
 * A one-shot named pipe. The launcher reads one line from it; `open` sends that line, and
 * closing without opening sends nothing, so the launcher exits without starting the shell.
 */
export function pipeStartupGate(id: string = randomUUID()): StartupGate {
  const path = `\\\\.\\pipe\\ace-terminal-gate-${id}`;
  let opened = false;
  let closed = false;
  let waiting: Socket | undefined;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    server.close();
    if (closed) socket.destroy();
    else if (opened) socket.end("go\r\n");
    else waiting = socket;
  });
  server.maxConnections = 1;
  server.unref();
  // A failed pipe leaves the launcher's read empty, so the shell never starts uncontained.
  server.on("error", () => {});
  server.listen(path);
  return {
    path,
    open() {
      if (opened || closed) return;
      opened = true;
      waiting?.end("go\r\n");
    },
    close() {
      closed = true;
      server.close();
      if (!opened) waiting?.destroy();
    },
  };
}

/** The gate's launcher: cmd.exe from a drive-absolute SystemRoot, else ComSpec. */
function gateLauncher(env: NodeJS.ProcessEnv): string {
  const systemRoot = windowsEnvValue(env, "systemroot");
  if (systemRoot && /^[A-Za-z]:[\\/]/.test(systemRoot))
    return win32.join(systemRoot, "System32", "cmd.exe");
  const comSpec = windowsEnvValue(env, "comspec");
  if (comSpec !== undefined) return comSpec;
  throw new Error("No cmd.exe found for the Windows terminal");
}

/**
 * The launcher's command line: without AutoRun or delayed expansion it reads one line from the
 * gate and only then runs the shell, so every process the shell starts is born inside the job.
 * An empty read fails `set /p` and the `&&` chain never starts the shell.
 */
function gatedCommandLine(gate: string, shell: string, args: readonly string[]): string {
  const run = windowsCmdLine(shell, args);
  return `/d /v:off /s /c "set /p ACE_TERMINAL_GATE=<"${gate}" && set "ACE_TERMINAL_GATE=" && ${run}"`;
}

export interface ConptyPorts {
  spawn?: (
    file: string,
    args: string[] | string,
    options: Parameters<typeof spawn>[2],
  ) => ConptyNative;
  /** Strict kernel containment. Every failure throws; there is no fallback. */
  createJob?: () => RetainedJob;
  openGate?: () => StartupGate;
  /** The cmd.exe that runs the gate; defaults to the host's. */
  launcher?: string;
}

/**
 * Windows: the shell runs under ConPTY (`useConptyDll`) inside a kill-on-close Job Object, which
 * replaces the POSIX session lease; `activeCount()` is the only liveness source and ownership
 * outlives shell exit until close empties the job. The dll kill path terminates the exact
 * console handle, so no PID is ever signalled.
 *
 * node-pty cannot create a process suspended or inside a job, so the first process is a gate:
 * cmd.exe waits on a pipe that opens only after it joined the job, then starts the shell. A
 * shell, AutoRun or profile that starts a child at once therefore starts it contained.
 */
export function createConptyBackendFactory(ports: ConptyPorts = {}): BackendFactory {
  const spawnNative = ports.spawn ?? spawn;
  const createJob = ports.createJob ?? (() => createRetainedJob());
  const openGate = ports.openGate ?? (() => pipeStartupGate());
  return (options, shell, context) => {
    const env = windowsTerminalEnv(options.env);
    assertTestEnvironmentIsolation(env);
    const launcher = ports.launcher ?? gateLauncher(process.env);
    const job = createJob();
    let gate: StartupGate | undefined;
    // An uncontained shell never runs on: stop its exact handle, then release the job.
    const abandon = (error: unknown, pty?: ConptyNative): never => {
      gate?.close();
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
      gate = openGate();
      pty = spawnNative(launcher, gatedCommandLine(gate.path, shell, options.args ?? []), {
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
    const started = gate;
    started.open();
    let drained = false;
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
      if (!drained) {
        try {
          job.terminate();
        } catch (error) {
          // A job that already emptied cannot be terminated; that is still a stopped tree.
          if (job.activeCount() !== 0) throw error;
        }
        await pollZero();
        // An empty job cannot gain members, so a release retry never touches the job again.
        drained = true;
        started.close();
      }
      // A failed close or unload retains ownership for retry; only a clean dispose completes it.
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
      onData(listener) {
        // ConPTY delivers utf8-decoded strings of whole code points.
        const subscription = pty.onData((input) =>
          listener(typeof input === "string" ? Buffer.from(input, "utf8") : decodeBytes(input)),
        );
        return () => subscription.dispose();
      },
      onExit(listener) {
        const subscription = pty.onExit((input) => {
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
