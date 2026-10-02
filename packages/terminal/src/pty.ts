import { accessSync, constants } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { constants as osConstants, tmpdir } from "node:os";
import { spawn } from "node-pty";
import type { ExitStatus, OpenTerminalOptions } from "./types.ts";
import { decodeBytes, decodeExit } from "./decode.ts";
import { sessionOwnership } from "./ownership.ts";
import type { ProcessControl, ShutdownScheduler } from "./ownership.ts";
import { createProcessTable } from "./process-table.ts";
import { createGroupLease } from "./group-lease.ts";
import type { GroupLease } from "./group-lease.ts";

export interface PtyBackend {
  readonly pid: number;
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
  createLease: () => GroupLease;
}

export const shutdownScheduler: ShutdownScheduler = {
  now: () => performance.now(),
  delay: async (ms) => {
    await setTimeout(ms);
  },
};

export function resolveShell(shell?: string): string {
  if (shell !== undefined) return shell;
  if (process.env.SHELL) return process.env.SHELL;
  for (const candidate of ["/bin/zsh", "/bin/bash"]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next installed shell. */
    }
  }
  throw new Error("No login shell found");
}

/** Each manager gets its own I/O context; overlapping shutdowns share a ps read. */
export function createPosixBackendFactory(
  ports?: PosixPorts,
  leaseRoot = tmpdir(),
): BackendFactory {
  const read = createProcessTable();
  return (options, shell, context) => {
    if (process.platform === "win32") throw new Error("Terminal service currently requires POSIX");
    const lease = ports ? ports.createLease() : createGroupLease(leaseRoot);
    const ignored = [...new Set(Object.values(osConstants.signals))]
      .filter(
        (signal) =>
          signal !== osConstants.signals.SIGKILL && signal !== osConstants.signals.SIGSTOP,
      )
      .join(" ");
    // The helper retains the ORIGINAL group ID, which cannot be reused while a
    // member remains. It inherits ignored catchable signals and exits on FIFO EOF.
    const launcher = `trap '' ${ignored}; /bin/sh -c 'printf ready >"$1"; while IFS= read -r line; do :; done' ace-lease "$2" <"$1" >/dev/null 2>&1 & keeper=$!; while [ ! -f "$2" ]; do kill -0 "$keeper" 2>/dev/null || exit 1; /bin/sleep 0.01; done; trap - ${ignored}; shift 2; exec "$@"`;
    const loginArgs = ["-l", "-i"];
    let pty: NativePty;
    try {
      pty = (ports?.spawn ?? spawn)(
        "/bin/sh",
        ["-c", launcher, "ace-terminal", lease.path, lease.readyPath, shell, ...loginArgs],
        {
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          name: "xterm-256color",
          env: { ...process.env, ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
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
    const base: ProcessControl = ports?.processes ?? {
      async read() {
        const deadline = context.scheduler.now() + 5000;
        for (let attempt = 0; !lease.ready() && !exited; attempt++) {
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
      signal(group, signal) {
        base.signal(group, signal);
        if (group === pty.pid && signal === "SIGKILL") leaseReleaseRequested = true;
      },
    };
    const ownership = sessionOwnership(context.owner, control, context.scheduler, pty.pid);
    return {
      pid: pty.pid,
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
        if (signal === "SIGKILL") lease.dispose();
      },
      close: async (graceMs) => {
        await ownership.close(graceMs);
        lease.dispose();
      },
    };
  };
}
