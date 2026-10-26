import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { terminateDirectoryProcesses } from "./directory-processes.ts";
import { registerGroup, unregisterGroup } from "./process-owner.ts";
import { ownedTree, type TreePorts } from "./process-tree.ts";

export { terminateDirectoryProcesses } from "./directory-processes.ts";

export interface ByteProcess {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number | null>;
  stop(): Promise<void>;
}
export interface ByteProcessOptions extends TreePorts {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Exclusive private Git directory used to identify helpers that detach from the group. */
  ownedCwd?: string;
  scheduleDrain?: (callback: () => void, milliseconds: number) => () => void;
}
/** Byte streams for binary CLI output; owns descendants and drains no unbounded line buffers. */
export function spawnBytes(options: ByteProcessOptions): ByteProcess {
  const tree = ownedTree(options.command, options.args, options);
  const { destroy } = tree;
  const child = spawn(tree.command, tree.args, {
    cwd: options.cwd,
    env: options.env,
    ...tree.spawnOptions,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const job = tree.contain(pid);
  let cleanup: Promise<void> | undefined;
  let closed = false;
  let cancelDrain: (() => void) | undefined;
  const terminate = () => {
    if (!cleanup)
      cleanup = (async () => {
        if (pid !== undefined) destroy(pid);
        // No lsof or /proc on Windows; the taskkill tree stop is the only reaper.
        if (options.ownedCwd && tree.platform !== "win32")
          await terminateDirectoryProcesses([options.ownedCwd]);
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
