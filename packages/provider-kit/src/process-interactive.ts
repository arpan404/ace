import { spawn } from "node:child_process";
import { killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";
import type { ProcessExit } from "./process.ts";
export type InteractiveProcess = {
  exited: Promise<ProcessExit>;
  stop(options?: { graceMs?: number }): Promise<ProcessExit>;
};
/** Inherit the terminal without capturing login output or credential input. */
export function spawnInteractive(options: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}): InteractiveProcess {
  if (process.platform === "win32") throw new Error("Interactive process ownership requires POSIX");
  const child = spawn(options.command, [...options.args], {
    env: options.env,
    stdio: "inherit",
    detached: true,
  });
  const pid = child.pid;
  let stopped = false;
  let failed = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (timer) clearTimeout(timer);
    if (pid !== undefined) {
      killGroup(pid, "SIGKILL");
      unregisterGroup(pid);
    }
  };
  child.once("error", () => {
    failed = true;
    release();
  });
  child.once("exit", release);
  const exited = new Promise<ProcessExit>((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      release();
      resolve({
        code,
        signal,
        reason: failed ? "spawn-error" : stopped ? "stopped" : signal ? "signal" : "exit",
      });
    }),
  );
  const handle: InteractiveProcess = {
    exited,
    stop({ graceMs = 500 } = {}) {
      if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("Invalid graceMs");
      if (!closed && !stopped && pid !== undefined) {
        stopped = true;
        killGroup(pid, "SIGTERM");
        timer = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
      }
      return exited;
    },
  };
  if (pid !== undefined) registerGroup(pid, (graceMs) => handle.stop({ graceMs }));
  return handle;
}
