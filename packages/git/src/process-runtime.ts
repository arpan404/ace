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
  if (child.pid && runtime.platform === "win32") {
    // Windows has no POSIX process groups. taskkill owns the whole descendant tree.
    return new Promise<void>((resolve) => {
      const killer = runtime.spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      killer.stdin.end();
      killer.stdout.resume();
      killer.stderr.resume();
      const cancel = runtime.scheduleTimeout(() => {
        killer.kill("SIGKILL");
        child.kill("SIGKILL");
      }, 10_000);
      killer.once("error", () => {
        cancel();
        child.kill("SIGKILL");
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
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else child.kill("SIGKILL");
  return Promise.resolve();
}
