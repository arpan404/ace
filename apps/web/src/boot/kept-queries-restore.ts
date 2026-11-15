import type { ClientApi } from "@ace/client";
import type { QueryClient } from "@tanstack/react-query";
import { persistQueries } from "@/lib/query-persistence.ts";
import type { DaemonTarget } from "./connection-settings.ts";
import { deviceId } from "./device-id.ts";
import { browserReadSnapshots } from "./read-snapshots.ts";

/** The build this page runs: a record another build wrote may hold data of another shape. */
const build = import.meta.env.VITE_ACE_BUILD ?? "dev";

/**
 * Restore `queries`' kept lookups for `target` and keep them from now on; returns the stop.
 * Loaded apart from the first paint (`kept-queries.ts`).
 */
export function keepQueries(
  queries: QueryClient,
  client: ClientApi,
  target: DaemonTarget,
  hostId: string,
): () => void {
  return persistQueries({
    queries,
    storage: browserReadSnapshots({ ...target, deviceId: target.pairedDeviceId ?? deviceId() }),
    build,
    hostId,
    writable: () => client.state === "ready",
    schedule(delayMs, run) {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
  });
}
