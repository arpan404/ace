import { useClient } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useLayoutEffect, useState, type CSSProperties } from "react";
import {
  artifactSize,
  keptArtifact,
  rememberArtifactSize,
  type ImageSize,
} from "./artifact-loads.ts";
import { readWhole } from "./attachment-content.ts";
import type { FileSource } from "./attachment-format.ts";
import { UnavailableImage } from "./attachment-message.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

type Source = Extract<FileSource, { kind: "artifact" }> & { mimeType: string };
const limit = 16 * 1024 * 1024;
/** The tallest an inline artifact image stands. */
const maxHeight = 320;

/**
 * The box an image of `size` takes: its own width, scaled down to the column and to `maxHeight`,
 * at its own shape. Set before the picture decodes, so the row is its final height at once.
 */
function boxOf(size: ImageSize): CSSProperties {
  const tallest = (size.width * maxHeight) / size.height;
  return {
    width: `min(100%, ${size.width}px, ${tallest}px)`,
    aspectRatio: `${size.width} / ${size.height}`,
  };
}

/**
 * Opaque artifact IDs resolve on the owning thread's authenticated connection. A row scrolled
 * out of the transcript and back shows its image with its first paint when the connection still
 * keeps the bytes, and at its own size either way once it has been shown: it never lands at a
 * placeholder's height and then moves the rows under it.
 */
export function ArtifactImage(props: { source: Source; name: string }) {
  const client = useClient();
  const { source } = props;
  const { threadId, artifactId, bytes, mimeType } = source;
  const key = `${threadId}\u0000${artifactId}`;
  const [loaded, setLoaded] = useState<{ client: ClientApi; key: string; url?: string }>();
  const [shown, setShown] = useState<{ key: string; size: ImageSize }>();
  const size = shown?.key === key ? shown.size : artifactSize(client, source);
  // A layout effect, so kept bytes paint with their row instead of a frame later.
  useLayoutEffect(() => {
    if (bytes > limit) return;
    const target = { kind: "artifact", threadId, artifactId, bytes } as const;
    let live = true;
    let url: string | undefined;
    const show = (blob: Blob | undefined) => {
      url = blob && blob.size <= limit ? URL.createObjectURL(blob) : undefined;
      setLoaded({ client, key, ...(url ? { url } : {}) });
    };
    const kept = keptArtifact(client, target);
    const abort = new AbortController();
    if (kept) show(kept.slice(0, kept.size, mimeType));
    else
      void readWhole(client, target, mimeType, abort.signal)
        .catch(() => undefined)
        .then((blob) => {
          if (live) show(blob);
        });
    return () => {
      live = false;
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, key, threadId, artifactId, bytes, mimeType]);
  if (bytes > limit || (loaded?.client === client && loaded.key === key && !loaded.url))
    return <UnavailableImage name={props.name} />;
  const url = loaded?.client === client && loaded.key === key ? loaded.url : undefined;
  const box = size && boxOf(size);
  // Until the bytes are here, or until a first image tells its size, a placeholder holds the
  // place: at the image's own size when it is known.
  const placeholder = box ? (
    <Skeleton className="rounded-lg" style={box} />
  ) : (
    <Skeleton className="h-32 w-60 rounded-lg" />
  );
  if (!url) return placeholder;
  return (
    <>
      {!box && placeholder}
      <img
        src={url}
        alt={props.name}
        hidden={!box}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (!image.naturalWidth || !image.naturalHeight) return;
          const natural = { width: image.naturalWidth, height: image.naturalHeight };
          rememberArtifactSize(client, source, natural);
          setShown({ key, size: natural });
        }}
        onError={() => setLoaded({ client, key })}
        className="block rounded-lg object-contain"
        style={box}
      />
    </>
  );
}
