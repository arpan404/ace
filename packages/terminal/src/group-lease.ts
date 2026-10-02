import {
  constants,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  existsSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface GroupLease {
  path: string;
  readyPath: string;
  ready(): boolean;
  alive(): boolean;
  dispose(): void;
}

/** The FIFO's writer belongs to the daemon. EOF releases the helper on daemon
 * exit, even when the login shell has exited or disowned its other children. */
export function createGroupLease(root: string): GroupLease {
  const directory = mkdtempSync(join(root, "ace-pty-lease-"));
  const path = join(directory, "lifetime");
  const readyPath = join(directory, "ready");
  let fd: number | undefined;
  let writerOnly = false;
  try {
    execFileSync("/usr/bin/mkfifo", ["-m", "600", path]);
    fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
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
    dispose() {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
