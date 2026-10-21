import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { terminateDirectoryProcesses } from "./directory-processes.ts";
import { killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";
import { killWindowsTree, type WindowsKillTree } from "./windows-tree.ts";
import { createKillOnCloseJob, type WindowsJob, type WindowsJobFactory } from "./windows-job.ts";
import { toWindowsCommand } from "./windows-command.ts";

export { terminateDirectoryProcesses } from "./directory-processes.ts";

export interface ByteProcess {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}
export interface ByteProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Exclusive private Git directory used to identify helpers that detach from the group. */
  ownedCwd?: string;
  scheduleDrain?: (callback: () => void, milliseconds: number) => () => void;
  /** Platform override for the Windows branch; tests inject "win32" without a Windows host. */
  platform?: NodeJS.Platform;
  /** Whole-tree stop used on Windows instead of process-group signals. */
  windowsKillTree?: WindowsKillTree;
  /** Kernel containment for the Windows tree; an unavailable job keeps the tree stop. */
  windowsJobFactory?: WindowsJobFactory;
}
/** Byte streams for binary CLI output; owns descendants and drains no unbounded line buffers. */
export function spawnBytes(options: ByteProcessOptions): ByteProcess {
  // No process groups exist on Windows; stop the whole tree with taskkill instead.
  const windows = (options.platform ?? process.platform) === "win32";
  const killTree = options.windowsKillTree ?? killWindowsTree;
  const destroy = (pid: number) => {
    if (windows) killTree(pid, true);
    else killGroup(pid, "SIGKILL");
  };
  const target = windows
    ? toWindowsCommand(options.command, options.args)
    : { command: options.command, args: [...options.args], verbatim: false };
  const child = spawn(target.command, target.args, {
    cwd: options.cwd,
    env: options.env,
    ...(windows ? { detached: false, windowsHide: true } : { detached: true }),
    windowsVerbatimArguments: target.verbatim,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const factory = options.windowsJobFactory ?? createKillOnCloseJob;
  const job: WindowsJob | undefined = windows && pid !== undefined ? factory() : undefined;
  if (pid !== undefined) job?.assign(pid);
  let cleanup: Promise<void> | undefined;
  let closed = false;
  let cancelDrain: (() => void) | undefined;
  const terminate = () => {
    if (!cleanup)
      cleanup = (async () => {
        if (pid !== undefined) destroy(pid);
        // No lsof or /proc on Windows; the taskkill tree stop is the only reaper.
        if (options.ownedCwd && !windows) await terminateDirectoryProcesses([options.ownedCwd]);
      })();
    return cleanup;
  };
  const closePipes = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const schedule =
    options.scheduleDrain ??
    ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", (error) => {
      closePipes();
      reject(error);
    });
    const drain = () => {
      if (closed || cancelDrain) return;
      // Start at leader exit even when a detached helper holds stdout open. Terminating
      // the private lease closes those writers; preserve buffered stdout and backpressure.
      cancelDrain = schedule(() => {
        void terminate().then(
          () => child.stderr.destroy(),
          (error) => {
            closePipes();
            reject(error);
          },
        );
      }, 100);
    };
    child.once("exit", () => {
      if (pid !== undefined) destroy(pid);
      drain();
    });
    child.once("close", (code) => {
      closed = true;
      cancelDrain?.();
      void (cleanup ?? Promise.resolve())
        .then(() => resolve(code), reject)
        .finally(() => {
          if (pid !== undefined) {
            unregisterGroup(pid);
            job?.dispose();
          }
        });
    });
  });
  const stop = async () => {
    try {
      await terminate();
    } finally {
      closePipes();
    }
    await exited.catch(() => {});
  };
  if (pid !== undefined) registerGroup(pid, stop, undefined, () => destroy(pid));
  return { stdout: child.stdout, stderr: child.stderr, exited, stop };
}
