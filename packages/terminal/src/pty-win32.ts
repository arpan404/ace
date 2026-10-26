import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { assertTestEnvironmentIsolation } from "@ace/provider-kit/test-isolation";
import { createRetainedWindowsJob } from "@ace/provider-kit/windows-job";
import type { RetainedWindowsJob } from "@ace/provider-kit/windows-job";
import type { ExitStatus, OpenTerminalOptions } from "./types.ts";
import { decodeBytes, decodeExit } from "./decode.ts";
import { WINDOWS_GATE_SOURCE } from "./windows-gate-source.ts";
import { mergeWindowsEnv } from "./shell.ts";
import type { BackendContext, BackendFactory, NativePty } from "./pty.ts";
import type { ShutdownScheduler } from "./ownership.ts";

export interface WindowsNativePty extends NativePty {
  kill(): void;
}

export interface WindowsGateInit {
  shell: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface WindowsGate {
  readonly script: string;
  readonly argv: string[];
  readonly init: WindowsGateInit;
  /** Explicit parent release: the gate spawns the shell only after this. */
  release(): void;
  /**
   * Best-effort removal of gate control files: must not throw, and the
   * backend guards it regardless so a cleanup failure can never mask process
   * ownership or fail a completed shutdown.
   */
  cleanup(): void;
}

export interface WindowsPorts {
  spawn?: (shell: string, args: string[], options: Parameters<typeof spawn>[2]) => WindowsNativePty;
  /** Strict kernel containment. Every failure throws; there is no fallback. */
  createRetainedJob?: () => RetainedWindowsJob;
  prepareGate?: (init: WindowsGateInit, root: string) => WindowsGate;
}

function defaultPrepareGate(init: WindowsGateInit, root: string): WindowsGate {
  // The gate source travels with the bundle as a module string, so there is
  // no asset file to stage. It is materialized as .mjs (always ESM: the temp
  // directory carries no package.json, where .js would parse as CommonJS).
  const directory = mkdtempSync(join(root, "ace-conpty-gate-"));
  try {
    const script = join(directory, "gate.mjs");
    const configPath = join(directory, "config.json");
    const releasePath = join(directory, "release");
    writeFileSync(script, WINDOWS_GATE_SOURCE);
    writeFileSync(
      configPath,
      JSON.stringify({ shell: init.shell, args: init.args, cwd: init.cwd, env: init.env }),
    );
    let cleaned = false;
    return {
      script,
      argv: [configPath, releasePath],
      init,
      release() {
        writeFileSync(releasePath, "");
      },
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // Control files are daemon-temp; a failed removal must not fail shutdown.
        }
      },
    };
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // The original write failure stays the cause.
    }
    throw error;
  }
}

/**
 * ConPTY backend for win32. Spawns the trusted Node bootstrap
 * (`process.execPath` + the embedded gate, `useConpty` with the shipped
 * `useConptyDll`); the gate waits for the daemon's explicit release, then
 * spawns the selected shell with inherited stdio. There is no `/bin/sh`
 * wrapper, FIFO lease, group keeper, `ps` table or POSIX signals. Tree
 * containment is the retained Windows job from
 * `@ace/provider-kit/windows-job`: `terminate()` stops the tree and
 * `activeCount()` is the sole liveness source. No taskkill command, no PID
 * signals, and no koffi calls are duplicated here — all Win32 stays behind
 * the public retained-job export.
 *
 * The dll kill path (`windowsPtyAgent.kill` with `useConptyDll`) closes the
 * input pipe and terminates the exact native shell handle: unlike the default
 * path it never enumerates the console list and never calls `process.kill`
 * on PIDs, so the 5-second-fallback PID-reuse hazard does not exist here.
 * Verified against the installed node-pty 1.1.0 `lib/windowsPtyAgent.js` and
 * `src/win/conpty.cc` (`PtyKill`: `ConptyClosePseudoConsole` plus
 * `TerminateProcess(hShell, 1)`). The VM must still confirm natural-exit
 * delivery, output drain, and the close path under this flag.
 *
 * Startup gate: the factory spawns the bootstrap, joins its pid to the job,
 * then releases it — synchronously with no await in between, before the
 * backend (and hence any write or output subscription) exists. Shell profiles
 * and user code only run after containment. Assignment or release failure
 * fails admission instead of proceeding uncontained. Residual risk: only a
 * child forked by the bootstrap itself before assignment escapes, and the
 * bootstrap forks nothing. The gate exits 1 if the release never arrives, so
 * a daemon death before assignment cannot strand an uncontained waiter.
 *
 * The bootstrap image runs with `NODE_OPTIONS` neutralized; the selected
 * shell keeps its full desired environment (including `NODE_OPTIONS`) via the
 * gate config file, never through inheritance.
 *
 * Ownership outlives shell exit until `close` confirms `activeCount() === 0`
 * and disposes the handle. Shell exit alone never completes ownership.
 *
 * Native gates: Windows 10 1903+ (build 18309+) x64/ARM64 with node-pty
 * prebuilds (`win32-x64`, `win32-arm64` including `conpty.dll`). No guardian
 * staging and no keeper compilation on win32. The gate needs no asset
 * staging: it is embedded as a module string and materialized per terminal.
 */
export function createWindowsBackendFactory(
  ports?: WindowsPorts,
  gateRoot: string = tmpdir(),
): BackendFactory {
  const spawnNative = ports?.spawn ?? ((shell, args, options) => spawn(shell, args, options));
  const createJob = ports?.createRetainedJob ?? (() => createRetainedWindowsJob());
  const prepareGate = ports?.prepareGate ?? defaultPrepareGate;
  return (options: OpenTerminalOptions, shell: string, context: BackendContext) => {
    const environment = mergeWindowsEnv(mergeWindowsEnv(process.env, options.env), {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    const shellEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment))
      if (value !== undefined) shellEnv[key] = value;
    assertTestEnvironmentIsolation(shellEnv);
    const shellArgs = options.args ?? [];
    // Windows env blocks are case-insensitive: every NODE_OPTIONS spelling
    // preloads the bootstrap unless removed. The shell keeps them via config.
    const gateEnv: Record<string, string> = { ...shellEnv };
    for (const key of Object.keys(gateEnv)) {
      if (key.toLowerCase() === "node_options") delete gateEnv[key];
    }
    const gate = prepareGate({ shell, args: shellArgs, cwd: options.cwd, env: shellEnv }, gateRoot);
    let pty: WindowsNativePty;
    try {
      pty = spawnNative(process.execPath, [gate.script, ...gate.argv], {
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        name: "xterm-256color",
        env: gateEnv,
        encoding: null,
        handleFlowControl: false,
        useConpty: true,
        useConptyDll: true,
      });
    } catch (error) {
      try {
        gate.cleanup();
      } catch {
        /* Keep the spawn failure. */
      }
      throw error;
    }
    let job: RetainedWindowsJob;
    try {
      job = createJob();
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        gate.cleanup();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        pty.kill();
      } catch {
        // Teardown is best-effort; collected failures preserve the primary.
      }
      if (failures.length > 1)
        throw new AggregateError(failures, "Windows terminal containment failed", {
          cause: error,
        });
      throw error;
    }
    try {
      // Join the bootstrap pid first, then release: the shell (and hence any
      // profile or user code) cannot exist before containment.
      job.assign(pty.pid);
      gate.release();
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        job.terminate();
      } catch (termination) {
        failures.push(termination);
      }
      try {
        job.dispose();
      } catch (disposal) {
        failures.push(disposal);
      }
      try {
        gate.cleanup();
      } catch (cleanup) {
        failures.push(cleanup);
      }
      try {
        pty.kill();
      } catch {
        // Cleanup only; the admission failure stays the cause.
      }
      if (failures.length > 1)
        throw new AggregateError(failures, "Windows terminal containment failed", {
          cause: error,
        });
      throw error;
    }
    let ownershipComplete = false;
    const scheduler: ShutdownScheduler = context.scheduler;

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
        let count: number;
        try {
          count = job.activeCount();
        } catch {
          throw error;
        }
        if (count !== 0) throw error;
      }
      await pollZero();
      // A disposal failure retains ownership for retry; only a clean dispose
      // completes it. Teardown below it is best-effort and never masks that.
      job.dispose();
      ownershipComplete = true;
      try {
        gate.cleanup();
      } catch {
        // Control-file removal must not fail a completed shutdown.
      }
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
        const subscription = pty.onData((input) => {
          // Live on Windows: the ConPTY socket is always utf8-decoded
          // upstream, so frames arrive as complete-code-point strings.
          if (typeof input === "string") listener(Buffer.from(input, "utf8"));
          else listener(decodeBytes(input));
        });
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
        // Windows has no POSIX signals and no graceful stop: anything but
        // SIGKILL is an explicit error so callers use close() instead of
        // silently receiving a force-kill dressed as grace.
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
