import type { ReadSnapshotStorage } from "@ace/client";
import type { TurnStepsStore } from "@ace/client/turn-steps";
import { createContext } from "react";
import type { DaemonTarget } from "./connection-settings.ts";
import { deviceId } from "./device-id.ts";

/*
 * Finished turns' steps kept between sessions, filed with this connection's read snapshots
 * (`read-snapshots.ts`): the same scope, so revoking this device, Disconnect and Forget the old
 * ace drop them with the threads. Each record is filed under the daemon that answered and
 * stamped with the build that wrote it; another daemon's or build's record is a miss. The
 * IndexedDB code loads on the first read or write, after first paint.
 */

/** The build this page runs: a record another build wrote may hold steps of another shape. */
const build = import.meta.env.VITE_ACE_BUILD ?? "dev";

export interface KeptConnection {
  target: DaemonTarget;
  hostId: string;
}

/** The connection finished turns are kept for; without one (fake daemon, tests) only in memory. */
export const KeptTurnStepsConnection = createContext<KeptConnection | undefined>(undefined);

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

/** The store of `connection`'s finished turns, in this browser's read snapshots. */
export function keptTurnSteps(connection: KeptConnection): TurnStepsStore {
  const { target, hostId } = connection;
  let opened: Promise<ReadSnapshotStorage | undefined> | undefined;
  const open = () =>
    (opened ??= import("./read-snapshots.ts").then(({ browserReadSnapshots }) =>
      typeof indexedDB === "undefined"
        ? undefined
        : browserReadSnapshots({ ...target, deviceId: target.pairedDeviceId ?? deviceId() }),
    ));
  return turnStepsStoreIn(open, { hostId, build });
}
