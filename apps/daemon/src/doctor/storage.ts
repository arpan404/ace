import type { DoctorFeature } from "./feature.ts";
import { BACKUPS_REPAIR, backupRepairs, backupsCheck } from "./storage-backup-repair.ts";
import { processAlive } from "@ace/service/home";
import { daemonLockCheck } from "./storage-locks.ts";
import { freeBytes, spaceCheck } from "./storage-space.ts";
import { DEFAULT_WALK_LIMITS, usageCheck, type WalkLimits } from "./storage-usage.ts";

export type StorageOptions = {
  walk?: WalkLimits;
  alive?: (pid: number) => boolean;
  freeBytes?: (directory: string) => Promise<number>;
};

/**
 * Storage and cleanup: what the data folder holds, leftover database backups (the one thing
 * it offers to delete), a stale daemon lock note, and free space against the largest database.
 */
export function createStorageFeature(options: StorageOptions = {}): DoctorFeature {
  const backups = backupRepairs();
  return {
    id: "storage",
    checks: (context) => [
      usageCheck(context, options.walk ?? DEFAULT_WALK_LIMITS),
      backupsCheck(context),
      daemonLockCheck(context.config.dataDir, options.alive ?? processAlive),
      spaceCheck(context.config.dataDir, options.freeBytes ?? freeBytes),
    ],
    repairs: (report, context) => backups.plan(report, context),
    async apply(repairId, report, context) {
      if (repairId !== BACKUPS_REPAIR)
        return [{ id: repairId, status: "skipped", message: "Not a storage repair." }];
      return backups.apply(report, context);
    },
  };
}

export const storage: DoctorFeature = createStorageFeature();
