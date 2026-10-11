import type { ClientApi } from "@ace/client";
import type { QueryClient } from "@tanstack/react-query";

interface Watch {
  hashes: Map<string, number>;
  stop(): void;
}
const byCache = new WeakMap<QueryClient, WeakMap<ClientApi, Watch>>();

/** One connection watcher per client/cache, regardless of how many views share each read. */
export function refreshOnReconnect(
  client: ClientApi,
  cache: QueryClient,
  hash: string,
): () => void {
  let clients = byCache.get(cache);
  if (!clients) {
    clients = new WeakMap();
    byCache.set(cache, clients);
  }
  let watch = clients.get(client);
  if (!watch) {
    const hashes = new Map<string, number>();
    let wasReady = client.state === "ready";
    const stop = client.connectionState().subscribe(() => {
      const ready = client.state === "ready";
      const arrived = ready && !wasReady;
      wasReady = ready;
      if (arrived)
        void cache.invalidateQueries({ predicate: (query) => hashes.has(query.queryHash) });
    });
    watch = { hashes, stop };
    clients.set(client, watch);
  }
  watch.hashes.set(hash, (watch.hashes.get(hash) ?? 0) + 1);
  const held = watch;
  return () => {
    const count = (held.hashes.get(hash) ?? 1) - 1;
    if (count) held.hashes.set(hash, count);
    else held.hashes.delete(hash);
    if (!held.hashes.size) {
      held.stop();
      clients.delete(client);
    }
  };
}
