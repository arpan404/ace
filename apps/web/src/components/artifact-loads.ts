import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { LruCache } from "@ace/ui-core";
import { WorkQueue } from "@/lib/work-queue.ts";
import type { FileSource } from "./attachment-format.ts";

type Source = Extract<FileSource, { kind: "artifact" }>;
const limit = 64 * 1024 * 1024;
interface Owner {
  queue: WorkQueue<Source, Blob>;
  cache: LruCache<string, Blob>;
}
const owners = new WeakMap<ClientApi, Owner>();
function owner(client: ClientApi) {
  const existing = owners.get(client);
  if (existing) return existing;
  const cache = new LruCache<string, Blob>({
    maxEntries: 16,
    maxWeight: 32 * 1024 * 1024,
    weigh: (blob) => blob.size,
  });
  const queue = new WorkQueue(
    async (source: Source, signal) => {
      const key = JSON.stringify([source.threadId, source.artifactId]);
      const cached = cache.get(key);
      if (cached) return cached;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let total = 0;
      for await (const chunk of client.downloadFile(
        {
          threadId: ThreadId.parse(source.threadId),
          op: "artifact.download",
          artifactId: source.artifactId,
          offset: 0,
        },
        { signal },
      )) {
        total += chunk.length;
        if (total > limit || (source.bytes > 0 && total > source.bytes))
          throw new Error("Artifact exceeds preview budget");
        chunks.push(
          chunk.buffer instanceof ArrayBuffer
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : chunk.slice(),
        );
      }
      if (signal.aborted) throw new Error("Preview cancelled");
      if (source.bytes > 0 && total !== source.bytes) throw new Error("Artifact size changed");
      const blob = new Blob(chunks);
      cache.set(key, blob);
      return blob;
    },
    { jobs: 16, bytes: limit },
  );
  const owned = { queue, cache };
  owners.set(client, owned);
  return owned;
}
/** Inline images, dialogs and downloads share bytes within their owning connection and thread. */
export async function artifactBlob(
  client: ClientApi,
  source: Source,
  signal: AbortSignal,
): Promise<Blob> {
  if (signal.aborted) throw new Error("Preview cancelled");
  const owned = owner(client);
  const key = JSON.stringify([source.threadId, source.artifactId]);
  const cached = owned.cache.get(key);
  if (cached) return cached;
  const lease = owned.queue.acquire(key, source, source.bytes || limit);
  const cancelled = Promise.withResolvers<never>();
  const abort = () => {
    lease.release();
    cancelled.reject(new Error("Preview cancelled"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const blob = await Promise.race([lease.result, cancelled.promise]);
    if (!blob) throw new Error("Preview busy or unavailable");
    return blob;
  } finally {
    signal.removeEventListener("abort", abort);
    lease.release();
  }
}
