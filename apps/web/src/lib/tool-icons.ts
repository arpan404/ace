import type { ClientApi } from "@ace/client";
import { ToolIconCache, toolIconKey, type IconImage } from "@ace/client/tool-icons";
import { useClient } from "@ace/client-react";
import type { IconRef, ToolIcon } from "@ace/protocol";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/*
 * The site favicons and app icons of browser and computer-use rows, as the daemon resolved them
 * on its host (never fetched by this page from the site itself). One cache per daemon client.
 */

const caches = new WeakMap<ClientApi, ToolIconCache>();

function cacheOf(client: ClientApi): ToolIconCache {
  let cache = caches.get(client);
  if (!cache) {
    cache = new ToolIconCache({
      resolve: (icons) => client.request({ type: "icons.resolve", icons }),
      read: (ref) => client.request({ type: "icons.read", ref }),
    });
    caches.set(client, cache);
  }
  return cache;
}

/** The icon's image: a data URL, null when it has none, undefined while it loads. */
export function useToolIcon(icon: ToolIcon | undefined, ref?: IconRef): IconImage {
  const cache = cacheOf(useClient());
  const key = icon ? toolIconKey(icon) : "";
  const read = useCallback(() => (icon ? cache.image(icon) : null), [cache, icon]);
  const image = useSyncExternalStore(
    useCallback((listener) => cache.subscribe(listener), [cache]),
    read,
    read,
  );
  useEffect(() => {
    if (icon && image === undefined) cache.load(icon, ref);
    // The key names the icon; `icon` itself is a fresh object every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key, ref, image]);
  return image;
}
