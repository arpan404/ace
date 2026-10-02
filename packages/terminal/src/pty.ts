import { accessSync, constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate, setTimeout } from "node:timers/promises";
import { spawn } from "node-pty";
import type { ExitStatus, OpenTerminalOptions } from "./types.ts";

export interface PtyBackend {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (bytes: Buffer) => void): () => void;
  onExit(listener: (status: ExitStatus) => void): () => void;
  kill(signal: NodeJS.Signals): Promise<void>;
  close(graceMs: number): Promise<void>;
}

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

const run = promisify(execFile);

interface ProcessRow {
  pid: number;
  parent: number;
  group: number;
  state: string;
}

async function processes(): Promise<ProcessRow[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, group, state = ""] = line.trim().split(/\s+/);
      const row = { pid: Number(pid), parent: Number(parent), group: Number(group), state };
      if (
        !Number.isSafeInteger(row.pid) ||
        row.pid < 1 ||
        !Number.isSafeInteger(row.parent) ||
        row.parent < 0 ||
        !Number.isSafeInteger(row.group) ||
        row.group < 0 ||
        !row.state
      ) {
        throw new Error("Malformed POSIX process table row");
      }
      return row;
    });
}

async function signalGroups(groups: Set<number>, signal: NodeJS.Signals): Promise<void> {
  const live = new Set(
    (await processes()).filter((row) => !row.state.startsWith("Z")).map((row) => row.group),
  );
  for (const group of groups) {
    if (!live.has(group)) continue;
    try {
      process.kill(-group, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error)) throw error;
      if (error.code === "ESRCH") continue;
      // macOS can report EPERM for a group containing only unreaped zombies.
      if (
        error.code === "EPERM" &&
        !(await processes()).some((row) => row.group === group && !row.state.startsWith("Z"))
      )
        continue;
      throw error;
    }
  }
}

/** POSIX backend. Job-control shells put foreground/background jobs in separate groups. */
export function openPosixPty(options: OpenTerminalOptions, shell: string): PtyBackend {
  if (process.platform === "win32") throw new Error("Terminal service currently requires POSIX");
  const pty = spawn(shell, ["-l", "-i"], {
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
    env: { ...process.env, ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    encoding: null,
    handleFlowControl: false,
  });
  const groups = new Set([pty.pid]);
  let exited = false;
  pty.onExit(() => {
    exited = true;
  });

  async function discoverGroups(): Promise<void> {
    if (exited) return;
    const rows = await processes();
    const descendants = new Set([pty.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const { pid, parent, group } of rows) {
        if (descendants.has(parent) && !descendants.has(pid)) {
          descendants.add(pid);
          if (group > 0) groups.add(group);
          changed = true;
        }
      }
    }
  }

  return {
    pid: pty.pid,
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    onData: (listener) => {
      // node-pty's declarations say string even with encoding:null. Validate the boundary.
      const subscription = pty.onData((data: unknown) => {
        if (!Buffer.isBuffer(data)) throw new TypeError("Raw PTY output must be a Buffer");
        listener(data);
      });
      return () => subscription.dispose();
    },
    onExit: (listener) => {
      const subscription = pty.onExit((event) =>
        listener({ code: event.exitCode, signal: event.signal || null }),
      );
      return () => subscription.dispose();
    },
    async kill(signal) {
      if (exited && groups.size === 1) return;
      await discoverGroups();
      await signalGroups(groups, signal);
    },
    async close(graceMs) {
      if (exited && groups.size === 1) return;
      await discoverGroups();
      await signalGroups(groups, "SIGTERM");
      // Keep the captured job groups even if the shell exits before an ignoring child.
      await setTimeout(graceMs);
      await signalGroups(groups, "SIGKILL");
      while ((await processes()).some((row) => groups.has(row.group) && !row.state.startsWith("Z")))
        await setImmediate();
      groups.clear();
    },
  };
}
