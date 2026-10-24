import type { ClientApi } from "@ace/client";
import type { ImageSource } from "./attachment-format.ts";
import { ByteLoads, type ImageLease } from "./byte-loads.ts";

export { permanentFailure, type ImageLease } from "./byte-loads.ts";

export type AttachmentSource = Extract<ImageSource, { kind: "attachment" }>;
export type ImageVariant = "thumbnail" | "original";
export const originalLimit = 32 * 1024 * 1024;
// A thumbnail read admits one bounded preview (512 px long edge); originals admit exact bytes.
const thumbnailLimit = 512 * 1024;

type Target = { source: AttachmentSource; variant: ImageVariant };

/** One connection's shared image reads. Two reads match the daemon decoder budget; originals
 * also share a 32 MiB in-flight budget. Queueing, reconnects and retries are `ByteLoads`'.
 */
export class AttachmentLoads {
  private loads: ByteLoads<Target>;
  constructor(client: ClientApi, schedule: (delay: number, callback: () => void) => () => void) {
    this.loads = new ByteLoads<Target>(client, schedule, {
      key: ({ source, variant }) => `${source.threadId}\u0000${source.sha256}\u0000${variant}`,
      weight: ({ source, variant }) => (variant === "thumbnail" ? thumbnailLimit : source.bytes),
      concurrency: 2,
      budget: originalLimit,
      kept: { maxEntries: 96, maxWeight: 48 * 1024 * 1024 },
      async read({ source, variant }, signal) {
        const { bytes, mimeType } = await client.attachmentBytes(
          {
            threadId: source.threadId,
            sha256: source.sha256,
            variant,
            ...(variant === "original" ? { maxBytes: source.bytes } : {}),
          },
          { signal },
        );
        // Client reads own their ArrayBuffer. Blob snapshots it, so no extra full-array slice
        // is needed. Keep a bounded copy fallback for an alternative client's shared buffer.
        const part =
          bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : bytes.slice();
        return new Blob([part], { type: mimeType });
      },
    });
  }
  cached(source: AttachmentSource, variant: ImageVariant): Blob | undefined {
    return this.loads.cached({ source, variant });
  }
  /** Forget kept bytes the browser could not show, so the next read asks the daemon again. */
  evict(source: AttachmentSource, variant: ImageVariant): void {
    this.loads.evict({ source, variant });
  }
  acquire(source: AttachmentSource, variant: ImageVariant): ImageLease {
    return this.loads.acquire({ source, variant });
  }
}
