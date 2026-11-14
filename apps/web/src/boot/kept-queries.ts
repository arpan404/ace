import type { ClientApi } from "@ace/client";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DaemonTarget } from "./connection-settings.ts";
import { deviceId } from "./device-id.ts";

/** The build this page runs: a record another build wrote may hold data of another shape. */
const build = import.meta.env.VITE_ACE_BUILD ?? "dev";

let loading:
  | Promise<[typeof import("@/lib/query-persistence.ts"), typeof import("./read-snapshots.ts")]>
  | undefined;
/**
 * The lookup cache's code, loaded once. Called from the page's entry alongside the connection
 * gate, so the cache is ready to restore when the app mounts instead of starting its download
 * then; a failed load is tried again on the next call.
 */
export function loadKeptQueries() {
  loading ??= Promise.all([import("@/lib/query-persistence.ts"), import("./read-snapshots.ts")]);
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

/**
 * Keep `queries`' daemon lookups between sessions, filed with this connection's read snapshots
 * (`read-snapshots.ts`): the same scope, so revoking this device, Disconnect and Forget the old
 * ace drop them with the threads. Its code loads apart from the first paint (`loadKeptQueries`);
 * the app never waits for it.
 */
export function useKeptQueries(
  queries: QueryClient,
  client: ClientApi,
  connection: { target: DaemonTarget | undefined; hostId: string },
): void {
  const { target, hostId } = connection;
  useEffect(() => {
    // A machine opened through the ace account has no stored target: nothing is kept for it.
    if (!target) return;
    let stop: (() => void) | undefined;
    let ended = false;
    void loadKeptQueries().then(
      ([{ persistQueries }, { browserReadSnapshots }]) => {
        if (ended || typeof indexedDB === "undefined") return;
        stop = persistQueries({
          queries,
          storage: browserReadSnapshots({
            ...target,
            deviceId: target.pairedDeviceId ?? deviceId(),
          }),
          build,
          hostId,
          writable: () => client.state === "ready",
          schedule(delayMs, run) {
            const timer = setTimeout(run, delayMs);
            return () => clearTimeout(timer);
          },
        });
      },
      (error: unknown) => console.error("ace: couldn't load the lookup cache", error),
    );
    return () => {
      ended = true;
      stop?.();
    };
  }, [queries, client, target, hostId]);
}
