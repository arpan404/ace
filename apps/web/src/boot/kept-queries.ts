import type { ClientApi } from "@ace/client";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DaemonTarget } from "./connection-settings.ts";

let loading: Promise<typeof import("./kept-queries-restore.ts")> | undefined;
/**
 * The lookup cache's code, loaded once. Called from the page's entry alongside the connection
 * gate, so the cache is ready to restore when the app mounts instead of starting its download
 * then. A failed load leaves this session without the cache, as before.
 */
export function loadKeptQueries() {
  return (loading ??= import("./kept-queries-restore.ts"));
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
      ({ keepQueries }) => {
        if (!ended && typeof indexedDB !== "undefined")
          stop = keepQueries(queries, client, target, hostId);
      },
      (error: unknown) => console.error("ace: couldn't load the lookup cache", error),
    );
    return () => {
      ended = true;
      stop?.();
    };
  }, [queries, client, target, hostId]);
}
