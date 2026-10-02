import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { GitProcessRuntime } from "./types.ts";

export function processRuntime(overrides: Partial<GitProcessRuntime> = {}): GitProcessRuntime {
  return {
    spawn: (command, args, options) => spawn(command, args, options),
    scheduleTimeout: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
    platform: process.platform,
    ...overrides,
  };
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
