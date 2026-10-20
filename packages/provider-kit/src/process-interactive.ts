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
  stdout?: "stdout" | "stderr";
}): InteractiveProcess {
  if (process.platform === "win32") throw new Error("Interactive process ownership requires POSIX");
  const child = spawn(options.command, [...options.args], {
    env: options.env,
    stdio: ["inherit", options.stdout === "stderr" ? 2 : "inherit", "inherit"],
    detached: true,
  });
  const pid = child.pid;
  let stopped = false;
  let failed = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killAt: number | undefined;
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
      const at = performance.now() + graceMs;
      // A later, shorter stop brings the SIGKILL forward; it never pushes one back.
      if (!closed && pid !== undefined && (!stopped || (killAt !== undefined && at < killAt))) {
        if (!stopped) killGroup(pid, "SIGTERM");
        stopped = true;
        killAt = at;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
      }
      return exited;
    },
  };
  if (pid !== undefined) registerGroup(pid, (graceMs) => handle.stop({ graceMs }));
  return handle;
}
