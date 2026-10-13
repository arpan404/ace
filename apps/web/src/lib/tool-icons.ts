import type { ClientApi } from "@ace/client";
import { ToolIconCache, type IconImage } from "@ace/client/tool-icons";
import { useClient } from "@ace/client-react";
import { ThreadId, type IconRef } from "@ace/protocol";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/*
 * The site favicons and app icons of browser and computer-use rows, as the daemon resolved them
 * on its host for the thread's own recorded steps (never fetched by this page from the site
 * itself). One cache per daemon client.
 */

const caches = new WeakMap<ClientApi, ToolIconCache>();

function cacheOf(client: ClientApi): ToolIconCache {
  let cache = caches.get(client);
  if (!cache) {
    cache = new ToolIconCache({
      resolve: (threadId, itemIds) => client.request({ type: "icons.resolve", threadId, itemIds }),
      read: (ref) => client.request({ type: "icons.read", ref }),
      // The page's wall clock, at the browser boundary.
      now: () => Date.now(),
      schedule: (run, ms) => void setTimeout(run, ms),
    });
    caches.set(client, cache);
  }
  return cache;
}

/** A step's icon: a data URL, null when it has none, undefined while it loads. */
export function useToolIcon(threadId: string, itemId: string, ref?: IconRef): IconImage {
  const cache = cacheOf(useClient());
  const read = useCallback(() => cache.image(threadId, itemId), [cache, threadId, itemId]);
  const image = useSyncExternalStore(
    useCallback((listener) => cache.subscribe(listener), [cache]),
    read,
    read,
  );
  // An icon the daemon said may come later waits; the cache says when the wait is over, and the
  // row asks again right then.
  const readWaiting = useCallback(() => cache.waiting(threadId, itemId), [cache, threadId, itemId]);
  const waiting = useSyncExternalStore(
    useCallback((listener) => cache.subscribe(listener), [cache]),
    readWaiting,
    readWaiting,
  );
  useEffect(() => {
    if (image === undefined && !waiting) cache.load(ThreadId.parse(threadId), itemId, ref);
  }, [cache, threadId, itemId, ref, image, waiting]);
  return image;
}
