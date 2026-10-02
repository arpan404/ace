import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";

export type ProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: "exit" | "signal" | "stopped" | "spawn-error";
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
};

const groups = new Set<number>();
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Darwin reports EPERM for groups containing only zombies before Node reaps
    // the leader. Its exit hook retries cleanup for any surviving descendants.
    if (code !== "ESRCH" && !(process.platform === "darwin" && code === "EPERM")) throw error;
  }
}
function cleanup(): void {
  for (const pid of groups) killGroup(pid, "SIGKILL");
}
function terminated(signal: NodeJS.Signals): void {
  cleanup();
  // Preserve the normal signal exit code, and let other application handlers run.
  if (process.listenerCount(signal) === 1) {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    process.kill(process.pid, signal);
  }
}
const onInt = () => terminated("SIGINT");
const onTerm = () => terminated("SIGTERM");
function register(pid: number): void {
  if (groups.size === 0) {
    process.on("exit", cleanup);
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
  }
  groups.add(pid);
}
function unregister(pid: number): void {
  groups.delete(pid);
  if (groups.size === 0) {
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

/** Own a POSIX process group, including grandchildren that keep its pipes open. */
export function spawnSupervised(options: SpawnOptions): SupervisedProcess {
  if (process.platform === "win32") {
    throw new Error("Process-group supervision requires POSIX; Windows needs a Job Object owner");
  }
  const child = spawn(options.command, [...(options.args ?? [])], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
  const pid = child.pid;
  if (pid !== undefined) register(pid);
  let stopped = false;
  let failed = false;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Pipe errors are surfaced to writers through write callbacks, never unhandled events.
  child.stdin.on("error", () => {});
  const release = () => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    if (pid !== undefined) {
      killGroup(pid, "SIGKILL");
      unregister(pid);
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
      resolve({
        code,
        signal,
        reason: failed ? "spawn-error" : stopped ? "stopped" : signal ? "signal" : "exit",
      });
    });
  });
  return {
    stdin: child.stdin,
    stdout,
    stderr,
    exited,
    signal: controller.signal,
    stop({ graceMs = 5_000 } = {}) {
      if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("Invalid graceMs");
      if (!ended && !stopped && pid !== undefined) {
        stopped = true;
        killGroup(pid, "SIGTERM");
        timer = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
      }
      return exited;
    },
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
  } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const proc = spawnSupervised({ command, args, env: options.env ?? {}, name: "cli-probe" });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let failure: Error | undefined;
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
  }
}
export async function probe(command: string, args: readonly string[]): Promise<string> {
  const output = await probeOutput(command, args);
  if (output.code !== 0) throw new Error("Probe exited unsuccessfully");
  return output.stdout;
}
