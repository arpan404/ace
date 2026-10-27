import type { DoctorFeature } from "./feature.ts";
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
 * Storage: what the data folder holds, a stale daemon lock note, and free space against the
 * largest database.
 */
export function createStorageFeature(options: StorageOptions = {}): DoctorFeature {
  return {
    id: "storage",
    checks: (context) => [
      usageCheck(context, options.walk ?? DEFAULT_WALK_LIMITS),
      daemonLockCheck(context.config.dataDir, options.alive ?? processAlive),
      spaceCheck(context.config.dataDir, options.freeBytes ?? freeBytes),
    ],
  };
}

export const storage: DoctorFeature = createStorageFeature();
