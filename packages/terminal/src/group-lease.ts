import {
  constants,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  existsSync,
  writeSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { TerminalGroupReplySchema } from "@ace/protocol";
import { constants as osConstants } from "node:os";
import type { ShutdownScheduler } from "./ownership.ts";
import { join } from "node:path";

export interface GroupLease {
  path: string;
  readyPath: string;
  ready(): boolean;
  alive(): boolean;
  signalOwned?(group: number, signal: NodeJS.Signals): Promise<boolean>;
  dispose(): void;
}

/** The FIFO's writer belongs to the daemon. EOF releases the helper on daemon
 * exit, even when the login shell has exited or disowned its other children. */
export function createGroupLease(root: string, scheduler: ShutdownScheduler): GroupLease {
  const directory = mkdtempSync(join(root, "ace-pty-lease-"));
  const path = join(directory, "lifetime");
  const readyPath = join(directory, "ready");
  let fd: number | undefined;
  let writerOnly = false;
  let sequence = 0;
  let busy = false;
  try {
    execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
    fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const lease: GroupLease = {
    path,
    readyPath,
    ready: () => existsSync(readyPath),
    alive() {
      if (fd === undefined || !existsSync(readyPath)) return false;
      try {
        if (!writerOnly) {
          const writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
          closeSync(fd);
          fd = writer;
          writerOnly = true;
        }
        // A byte write proves a reader still holds THIS FIFO. It cannot validate
        // an unrelated process just because a numeric PID/group was recycled.
        writeSync(fd, "\n");
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EAGAIN") return true;
        return false;
      }
    },
    async signalOwned(group, signal) {
      if (busy) throw new Error("Terminal guardian request already in progress");
      if (!lease.alive() || fd === undefined) throw new Error("Terminal guardian unavailable");
      busy = true;
      const id = ++sequence;
      const responsePath = `${readyPath}.${id}`;
      try {
        writeSync(fd, `${id} ${group} ${osConstants.signals[signal]}\n`);
        const deadline = scheduler.now() + 5000;
        while (!existsSync(responsePath)) {
          if (scheduler.now() >= deadline) throw new Error("Terminal guardian response timed out");
          if (!lease.alive()) throw new Error("Terminal guardian exited");
          await scheduler.delay(0);
        }
        const value: unknown = JSON.parse(readFileSync(responsePath, "utf8"));
        const response = TerminalGroupReplySchema.parse(value);
        if (response.id !== id) throw new Error("Terminal guardian response mismatch");
        if (response.result === -1)
          throw new Error(`Terminal guardian failed: errno ${response.error}`);
        return response.result === 1;
      } finally {
        busy = false;
        try {
          unlinkSync(responsePath);
        } catch (error) {
          // The lease directory is removed on disposal even if reply removal fails.
          void error;
        }
      }
    },
    dispose() {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
  return lease;
}
