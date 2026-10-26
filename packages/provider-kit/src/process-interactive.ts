import { spawn } from "node:child_process";
import { registerGroup, unregisterGroup } from "./process-owner.ts";
import { ownedTree, type TreePorts } from "./process-tree.ts";
import type { ProcessExit } from "./process.ts";
export type InteractiveProcess = {
  exited: Promise<ProcessExit>;
  stop(options?: { graceMs?: number }): Promise<ProcessExit>;
};
/** Inherit the terminal without capturing login output or credential input. */
export function spawnInteractive(
  options: TreePorts & {
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    stdout?: "stdout" | "stderr";
  },
): InteractiveProcess {
  const tree = ownedTree(options.command, options.args, options);
  const { terminate, destroy } = tree;
  const child = spawn(tree.command, tree.args, {
    env: options.env,
    stdio: ["inherit", options.stdout === "stderr" ? 2 : "inherit", "inherit"],
    ...tree.spawnOptions,
    // The console stays visible: login owns credential entry and browser handoff.
    windowsHide: false,
  });
  const pid = child.pid;
  const job = tree.contain(pid);
  let stopped = false;
  let failed = false;
  let closed = false;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killAt: number | undefined;
  const release = () => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    if (pid !== undefined) {
      destroy(pid);
      unregisterGroup(pid);
    }
    job?.dispose();
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
        if (!stopped) terminate(pid);
        stopped = true;
        killAt = at;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => destroy(pid), graceMs);
      }
      return exited;
    },
  };
  if (pid !== undefined)
    registerGroup(
      pid,
      (graceMs) => handle.stop({ graceMs }),
      undefined,
      () => destroy(pid),
    );
  return handle;
}
