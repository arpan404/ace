import { spawn } from "node:child_process";
import { killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";
import { killWindowsTree, type WindowsKillTree } from "./process-owner.ts";
import { groupOf, toWindowsCommand } from "./process-owner.ts";
import {
  createKillOnCloseJob,
  type WindowsJob,
  type WindowsJobFactory,
} from "./process-containment.ts";
import type { ProcessExit } from "./process.ts";
import { markedEnv } from "./process-marker.ts";
import { supervisorBackend } from "./native-switches.ts";
import {
  launchEnv,
  nativeChildJob,
  nativeKillWindowsTree,
  nativeSpawnChild,
  NativeChildProcess,
  type SpawnedHandle,
} from "./native-process.ts";
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
  /** Platform override for the Windows branch; tests inject "win32" without a Windows host. */
  platform?: NodeJS.Platform;
  /** Whole-tree stop used on Windows instead of process-group signals. */
  windowsKillTree?: WindowsKillTree;
  /** Kernel containment for the Windows tree; an unavailable job keeps the tree stop. */
  windowsJobFactory?: WindowsJobFactory;
}): InteractiveProcess {
  // Process groups do not exist on Windows; contain the tree with a Job Object and taskkill.
  const windows = (options.platform ?? process.platform) === "win32";
  const native = supervisorBackend() === "native";
  const killTree = options.windowsKillTree ?? (native ? nativeKillWindowsTree : killWindowsTree);
  const terminate = (pid: number) => {
    if (windows) killTree(pid, false);
    else killGroup(pid, "SIGTERM", groupOf(child));
  };
  const destroy = (pid: number) => {
    if (windows) killTree(pid, true);
    else killGroup(pid, "SIGKILL", groupOf(child));
  };
  const target = windows
    ? toWindowsCommand(options.command, options.args)
    : { command: options.command, args: [...options.args], verbatim: false };
  const child: SpawnedHandle = native
    ? nativeSpawnChild({
        command: target.command,
        args: target.args,
        env: launchEnv(markedEnv(options.env)),
        stdin: "inherit",
        stdout: options.stdout === "stderr" ? "stderr" : "inherit",
        stderr: "inherit",
        verbatim: target.verbatim,
        // The console stays visible: login owns credential entry and browser handoff.
        hide: false,
        contain: windows && options.windowsJobFactory === undefined,
      })
    : spawn(target.command, target.args, {
        env: markedEnv(options.env),
        stdio: ["inherit", options.stdout === "stderr" ? 2 : "inherit", "inherit"],
        // The console stays visible: login owns credential entry and browser handoff.
        ...(windows ? { detached: false, windowsHide: false } : { detached: true }),
        windowsVerbatimArguments: target.verbatim,
      });
  const pid = child.pid;
  const factory =
    options.windowsJobFactory ?? (native ? () => nativeChildJob(child) : createKillOnCloseJob);
  const job: WindowsJob | undefined = windows && pid !== undefined ? factory() : undefined;
  if (pid !== undefined) job?.assign(pid);
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
  /** Frees the native child once no event can follow: error or close. */
  const disposeNative = () => {
    if (child instanceof NativeChildProcess) child.dispose();
  };
  child.once("error", () => {
    failed = true;
    disposeNative();
    release();
  });
  child.once("exit", release);
  const exited = new Promise<ProcessExit>((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      release();
      disposeNative();
      resolve({
        code,
        // After a failed spawn Bun reports no signal at all, where Node reports null.
        signal: signal ?? null,
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
      () => {
        if (child instanceof NativeChildProcess) child.dispose();
        destroy(pid);
      },
    );
  return handle;
}
