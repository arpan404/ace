import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { killGroup, registerGroup, unregisterGroup } from "./process-owner.ts";

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
}
/** Byte streams for binary CLI output; owns descendants and drains no unbounded line buffers. */
export function spawnBytes(options: ByteProcessOptions): ByteProcess {
  if (process.platform === "win32") throw new Error("Process groups require POSIX");
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const release = () => {
    if (pid !== undefined) {
      killGroup(pid, "SIGKILL");
      unregisterGroup(pid);
    }
    // A descendant that escaped the group must not hold close hostage through inherited pipes.
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", (error) => {
      release();
      reject(error);
    });
    child.once("exit", () => {
      if (pid !== undefined) {
        killGroup(pid, "SIGKILL");
        unregisterGroup(pid);
      }
    });
    child.once("close", (code) => resolve(code));
  });
  const stop = async () => {
    release();
    await exited.catch(() => {});
  };
  if (pid !== undefined) registerGroup(pid, stop);
  return { stdout: child.stdout, stderr: child.stderr, exited, stop };
}
