import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { LruCache } from "@ace/ui-core";
import { useLayoutEffect, useState, type ReactNode } from "react";
import type { ImageSource } from "./attachment-format.ts";

/*
 * Image bytes for the transcript. Attachments come only through the owning connection
 * (`client.attachmentBytes`), never from a URL built from a path or port. Fetched blobs are kept
 * in a small LRU per connection, so a thumbnail scrolled out of the virtualized transcript and
 * back shows at once; each mounted image holds its own object URL and revokes it on unmount.
 */

/** The client refuses originals above 32 MiB. */
const originalLimit = 32 * 1024 * 1024;

interface Cache {
  blobs: LruCache<string, Blob>;
  pending: Map<string, Promise<Blob>>;
}
const caches = new WeakMap<ClientApi, Cache>();
function cacheOf(client: ClientApi): Cache {
  let cache = caches.get(client);
  if (!cache) {
    cache = {
      blobs: new LruCache({ maxEntries: 96, maxWeight: 48 * 1024 * 1024, weigh: (b) => b.size }),
      pending: new Map(),
    };
    caches.set(client, cache);
  }
  return cache;
}

type Variant = "thumbnail" | "original";
type AttachmentSource = Extract<ImageSource, { kind: "attachment" }>;

/** A preview uses the daemon's bounded thumbnail when it has one; a full view the original. */
function variantOf(source: AttachmentSource, full: boolean): Variant | undefined {
  if (full) return source.bytes <= originalLimit ? "original" : "thumbnail";
  if (source.thumbnail) return "thumbnail";
  return source.bytes <= originalLimit ? "original" : undefined;
}

const keyOf = (source: AttachmentSource, variant: Variant) =>
  `${source.threadId}\u0000${source.sha256}\u0000${variant}`;

function cached(client: ClientApi, source: AttachmentSource, variant: Variant): Blob | undefined {
  return cacheOf(client).blobs.get(keyOf(source, variant));
}

function load(client: ClientApi, source: AttachmentSource, variant: Variant): Promise<Blob> {
  const cache = cacheOf(client);
  const key = keyOf(source, variant);
  let pending = cache.pending.get(key);
  if (!pending) {
    pending = client
      .attachmentBytes({
        threadId: source.threadId,
        sha256: source.sha256,
        variant,
        ...(variant === "original" ? { maxBytes: Math.max(1, source.bytes) } : {}),
      })
      .then(({ bytes, mimeType }) => {
        const blob = new Blob([bytes.slice()], { type: mimeType });
        cache.blobs.set(key, blob);
        return blob;
      })
      .finally(() => cache.pending.delete(key));
    cache.pending.set(key, pending);
  }
  return pending;
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
  const [loaded, setLoaded] = useState<{ key: string; state: ImageState }>();
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
      setLoaded({ key, state: { state: "ready", url: objectUrl } });
    };
    const hit = cached(client, target, variant);
    if (hit) show(hit);
    else
      load(client, target, variant).then(
        (blob) => {
          if (live) show(blob);
        },
        () => {
          if (live) setLoaded({ key, state: { state: "unavailable" } });
        },
      );
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, key, threadId, sha256, bytes, thumbnail, variant]);
  if (!variant) return unavailable;
  return loaded?.key === key ? loaded.state : loading;
}
