import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isDiskFull } from "./sqlite-failure.ts";

/**
 * Space ace keeps for itself under ACE_HOME (ADR 0174): one file of zeros, written while the
 * disk has room and removed the moment it fills. On a disk with no free block at all SQLite
 * cannot even open a database in WAL mode, since a clean close removed its `-wal` and `-shm`
 * files and they can't be made again. With the reserve removed the daemon's stores open, its
 * reads work and the writes it was holding land, while new work stays held until the person
 * frees space. Once space is back the reserve is written again.
 */
export const reserveBytes = 16 * 1024 * 1024;

export interface StorageReserve {
  /** Removes the reserve; true when there was one to remove. Never throws. */
  release(): boolean;
  /**
   * Writes the reserve when it is missing or short. False only when the disk or the person's
   * quota refused it for want of space; any other failure leaves no reserve and isn't a reason
   * to keep new work held. Never throws.
   */
  restore(): boolean;
  /** Bytes of the reserve not on disk now: freed for ace, so not the person's free space. */
  missing(): number;
}

export function storageReserve(home: string, bytes = reserveBytes): StorageReserve {
  const path = join(home, "storage-reserve");
  const remove = (): boolean => {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  };
  const size = (): number => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  };
  return {
    release: remove,
    missing: () => Math.max(0, bytes - size()),
    restore() {
      if (size() >= bytes) return true;
      const chunk = Buffer.alloc(1024 * 1024);
      let failure: unknown;
      try {
        const fd = openSync(path, "w", 0o600);
        try {
          for (let written = 0; written < bytes; written += chunk.length) writeSync(fd, chunk);
        } catch (error) {
          failure = error;
        }
        // A close can fail too (EIO, or space a delayed allocation found missing): it counts.
        try {
          closeSync(fd);
        } catch (error) {
          failure ??= error;
        }
      } catch (error) {
        failure = error;
      }
      if (failure === undefined) return true;
      // Half a reserve only takes space the person needs: none is kept.
      remove();
      return !isDiskFull(failure);
    },
  };
}
