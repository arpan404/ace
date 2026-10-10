import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { useLayoutEffect, useState, type ReactNode } from "react";
import type { ImageSource } from "./attachment-format.ts";
import {
  AttachmentLoads,
  originalLimit,
  type AttachmentSource,
  type ImageVariant,
} from "./attachment-loads.ts";

/*
 * Image bytes for the transcript. Attachments come only through the owning connection
 * (`client.attachmentBytes`), never from a URL built from a path or port. Fetched blobs are kept
 * in a small LRU per connection, so a thumbnail scrolled out of the virtualized transcript and
 * back shows at once; each mounted image holds its own object URL and revokes it on unmount.
 */

const caches = new WeakMap<ClientApi, AttachmentLoads>();
function cacheOf(client: ClientApi): AttachmentLoads {
  let cache = caches.get(client);
  if (!cache) {
    cache = new AttachmentLoads(client, (delay, callback) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
    caches.set(client, cache);
  }
  return cache;
}

/** A preview uses the daemon's bounded thumbnail when it has one; a full view the original. */
function variantOf(source: AttachmentSource, full: boolean): ImageVariant | undefined {
  if (full) return source.bytes <= originalLimit ? "original" : "thumbnail";
  if (source.thumbnail) return "thumbnail";
  return source.bytes <= originalLimit ? "original" : undefined;
}

export type ImageState =
  | { state: "loading" }
  | { state: "ready"; url: string }
  | { state: "unavailable" };

const loading: ImageState = { state: "loading" };
const unavailable: ImageState = { state: "unavailable" };

/**
 * A URL for an image while it is mounted, handed to `children`. Inline and blob URLs pass
 * through without a connection; attachment bytes that this device can't fetch (gone, another
 * machine's, refused) read as unavailable. `full` asks for the original instead of a preview.
 */
export function ImageUrl(props: {
  source: ImageSource;
  full?: boolean | undefined;
  children: (image: ImageState) => ReactNode;
}): ReactNode {
  if (props.source.kind === "url") return props.children({ state: "ready", url: props.source.url });
  return (
    <AttachmentUrl source={props.source} full={props.full ?? false}>
      {props.children}
    </AttachmentUrl>
  );
}

function AttachmentUrl(props: {
  source: AttachmentSource;
  full: boolean;
  children: (image: ImageState) => ReactNode;
}): ReactNode {
  return props.children(useAttachmentUrl(props.source, props.full));
}

function useAttachmentUrl(source: AttachmentSource, full: boolean): ImageState {
  const client = useClient();
  // The attachment's state, tagged with the key it belongs to so a new source starts loading.
  const [loaded, setLoaded] = useState<{ client: ClientApi; key: string; state: ImageState }>();
  const { threadId, sha256, bytes, thumbnail } = source;
  const key = `${threadId}\u0000${sha256}\u0000${full}`;
  const variant = variantOf(source, full);
  // A layout effect, so a cached thumbnail paints with its row instead of a frame later.
  useLayoutEffect(() => {
    if (!variant) return;
    const target = { kind: "attachment", threadId, sha256, bytes, thumbnail } as const;
    let live = true;
    let objectUrl: string | undefined;
    const show = (blob: Blob) => {
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ client, key, state: { state: "ready", url: objectUrl } });
    };
    const cache = cacheOf(client);
    const hit = cache.cached(target, variant);
    const lease = hit ? undefined : cache.acquire(target, variant);
    if (hit) show(hit);
    else
      lease?.promise.then(
        (blob) => {
          if (live) show(blob);
        },
        () => {
          if (live) setLoaded({ client, key, state: { state: "unavailable" } });
        },
      );
    return () => {
      live = false;
      lease?.release();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, key, threadId, sha256, bytes, thumbnail, variant]);
  if (!variant) return unavailable;
  return loaded?.client === client && loaded.key === key ? loaded.state : loading;
}
