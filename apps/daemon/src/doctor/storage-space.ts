import { statfs } from "node:fs/promises";
import type { Check } from "@ace/diagnostics";
import { formatBytes } from "./format.ts";
import { readDataFolder } from "./storage-folder.ts";

/** Bytes this user may still write on the disk holding `directory`. */
export async function freeBytes(directory: string): Promise<number> {
  const fs = await statfs(directory);
  return fs.bavail * fs.bsize;
}

const FIX =
  "Free up space on this disk. Deleting old database backups (offered by ace doctor) or running ace clean can help.";

/**
 * An upgrade copies a database before changing it, and compaction rewrites its pages, so
 * both need room on the order of the largest database. The base `disk` check only looks at
 * an absolute floor.
 */
export function spaceCheck(dataDir: string, free: (directory: string) => Promise<number>): Check {
  return {
    id: "storage.space",
    fix: FIX,
    async run() {
      const largest = (await readDataFolder(dataDir)).databases[0];
      if (!largest) return { status: "ok", message: "No databases yet", fix: FIX };
      const available = await free(dataDir).catch(() => undefined);
      const need = largest.bytes + largest.walBytes;
      if (available === undefined)
        return {
          status: "ok",
          message: `Couldn't read free space; see the disk check. The largest database, ${largest.name}, is ${formatBytes(need)}`,
          fix: FIX,
        };
      if (available < need)
        return {
          status: "warn",
          message: `${formatBytes(available)} free, less than the largest database (${largest.name}, ${formatBytes(need)}). Upgrades copy a database before changing it and compaction rewrites it, so both can fail for lack of room.`,
          fix: FIX,
        };
      return {
        status: "ok",
        message: `${formatBytes(available)} free; the largest database, ${largest.name}, is ${formatBytes(need)}`,
        fix: FIX,
      };
    },
  };
}
