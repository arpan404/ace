import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { GitProcessRuntime } from "./types.ts";

export function processRuntime(overrides: Partial<GitProcessRuntime> = {}): GitProcessRuntime {
  return {
    spawn: spawnGitProcess,
    scheduleTimeout: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
    platform: process.platform,
    signalGroup: (pid, signal) => {
      process.kill(-pid, signal);
    },
    ...overrides,
  };
}
function piped(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}
/** Node's three-pipe overload does not describe additional inherited descriptors. Check the edge. */
export function spawnGitProcess(
  command: string,
  args: string[],
  options: Parameters<GitProcessRuntime["spawn"]>[2],
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, options);
  if (!piped(child)) {
    child.kill("SIGKILL");
    throw new Error("Git requires three owned pipes");
  }
  return child;
}

export function killTree(
  runtime: GitProcessRuntime,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  // An exited leader PID may have been reused. Without containment we cannot
  // safely signal that identity again; its escaped descendants remain unconfirmed.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (child.pid && runtime.platform === "win32") {
    // Windows has no POSIX process groups. Request descendant termination;
    // taskkill cannot prove containment of escaped writers.
    return new Promise<void>((resolve) => {
      const killer = runtime.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      killer.stdout.on("error", () => {});
      killer.stderr.on("error", () => {});
      killer.stdin.on("error", () => {});
      killer.stdin.end();
      killer.stdout.resume();
      killer.stderr.resume();
      const finish = () => {
        killer.stdin.destroy();
        killer.stdout.destroy();
        killer.stderr.destroy();
        killer.unref();
        resolve();
      };
      const cancel = runtime.scheduleTimeout(() => {
        killer.kill("SIGKILL");
        child.kill("SIGKILL");
        finish();
      }, 10_000);
      killer.once("error", () => {
        cancel();
        child.kill("SIGKILL");
        finish();
      });
      killer.once("close", (code) => {
        cancel();
        if (code !== 0) child.kill("SIGKILL");
        resolve();
      });
    }).catch(() => {
      child.kill("SIGKILL");
    });
  } else if (child.pid) {
    try {
      runtime.signalGroup(child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else child.kill("SIGKILL");
  return Promise.resolve();
}

/** Drain the owned leader without waiting for inherited pipes or claiming containment. */
export function drainProcessExit(
  child: ChildProcessWithoutNullStreams,
  schedule: GitProcessRuntime["scheduleTimeout"],
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let cancel: (() => void) | undefined;
    const finish = () => {
      cancel?.();
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    // Shutdown remains bounded even if a supervisor or the OS cannot stop the
    // leader. Durable quarantine and its cleanup receipt remain independent.
    cancel = schedule(finish, 1000);
  });
}
