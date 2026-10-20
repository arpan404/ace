import type { ClientApi } from "@ace/client";
import { ToolIconCache, type IconImage } from "@ace/client/tool-icons";
import { useClient } from "@ace/client-react";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/*
 * People's GitHub avatars (pull request authors, reviewers, commenters), relayed by the daemon:
 * the page never loads them from GitHub, which its content policy blocks and a remote client may
 * not reach. One cache per daemon client, asked in batches.
 */

const group = "avatars";
const caches = new WeakMap<ClientApi, ToolIconCache<typeof group>>();

function cacheOf(client: ClientApi): ToolIconCache<typeof group> {
  let cache = caches.get(client);
  if (!cache) {
    cache = new ToolIconCache<typeof group>({
      resolve: (_, urls) => client.request({ type: "avatars.resolve", urls }),
      read: (ref) => client.request({ type: "icons.read", ref }),
      // The page's wall clock, at the browser boundary.
      now: () => Date.now(),
      schedule: (run, ms) => void setTimeout(run, ms),
    });
    caches.set(client, cache);
  }
  return cache;
}

/** An avatar as a data URL; null when there is none, undefined while it loads (or no URL). */
export function useAvatar(url: string | undefined): IconImage {
  const cache = cacheOf(useClient());
  const key = url ?? "";
  const subscribe = useCallback((listener: () => void) => cache.subscribe(listener), [cache]);
  const read = useCallback(() => (key ? cache.image(group, key) : null), [cache, key]);
  const image = useSyncExternalStore(subscribe, read, read);
  const readWaiting = useCallback(() => cache.waiting(group, key), [cache, key]);
  const waiting = useSyncExternalStore(subscribe, readWaiting, readWaiting);
  useEffect(() => {
    if (key && image === undefined && !waiting) cache.load(group, key);
  }, [cache, key, image, waiting]);
  return image;
}
