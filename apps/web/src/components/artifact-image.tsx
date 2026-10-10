import { useClient } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { useEffect, useState } from "react";
import { readWhole } from "./attachment-content.ts";
import type { FileSource } from "./attachment-format.ts";
import { UnavailableImage } from "./attachment-message.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

type Source = Extract<FileSource, { kind: "artifact" }> & { mimeType: string };
/** Opaque artifact IDs resolve on the owning thread's authenticated connection. */
export function ArtifactImage(props: { source: Source; name: string }) {
  const client = useClient();
  const { threadId, artifactId, bytes, mimeType } = props.source;
  const key = `${threadId}\u0000${artifactId}`;
  const [loaded, setLoaded] = useState<{ client: ClientApi; key: string; url?: string }>();
  useEffect(() => {
    if (bytes > 16 * 1024 * 1024) return;
    const abort = new AbortController();
    let live = true;
    let url: string | undefined;
    void readWhole(
      client,
      { kind: "artifact", threadId, artifactId, bytes },
      mimeType,
      abort.signal,
    )
      .catch(() => undefined)
      .then((blob) => {
        if (!live) return;
        url = blob && blob.size <= 16 * 1024 * 1024 ? URL.createObjectURL(blob) : undefined;
        setLoaded({ client, key, ...(url ? { url } : {}) });
      });
    return () => {
      live = false;
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, key, threadId, artifactId, bytes, mimeType]);
  if (bytes > 16 * 1024 * 1024 || (loaded?.client === client && loaded.key === key && !loaded.url))
    return <UnavailableImage name={props.name} />;
  if (loaded?.client !== client || loaded.key !== key)
    return <Skeleton className="h-32 w-60 rounded-lg" />;
  return (
    <img
      src={loaded.url}
      alt={props.name}
      loading="lazy"
      onError={() => setLoaded({ client, key })}
      className="max-h-80 max-w-full rounded-lg object-contain"
    />
  );
}
