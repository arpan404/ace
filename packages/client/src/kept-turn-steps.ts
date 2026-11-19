import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
import type { TurnStepsStore } from "./turn-steps.ts";

/** Turn records in `storage` (opened on first use), filed under `hostId` and stamped `build`. */
export function turnStepsStoreIn(
  storage: () => Promise<ReadSnapshotStorage | undefined>,
  scope: { hostId: string; build: string },
): TurnStepsStore {
  const prefix = `turn-steps/${scope.hostId}/`;
  return {
    async get(key) {
      const kept = await (await storage())?.get(prefix + key);
      if (typeof kept !== "object" || kept === null) return undefined;
      return Reflect.get(kept, "build") === scope.build ? Reflect.get(kept, "record") : undefined;
    },
    async set(key, value) {
      await (await storage())?.set(prefix + key, { build: scope.build, record: value });
    },
  };
}
