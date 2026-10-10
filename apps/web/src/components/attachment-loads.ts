import { ClientError, type ClientApi } from "@ace/client";
import { LruCache } from "@ace/ui-core";
import type { ImageSource } from "./attachment-format.ts";

export type AttachmentSource = Extract<ImageSource, { kind: "attachment" }>;
export type ImageVariant = "thumbnail" | "original";
export const originalLimit = 32 * 1024 * 1024;
const thumbnailLimit = 256 * 1024;
const keyOf = (source: AttachmentSource, variant: ImageVariant) =>
  `${source.threadId}\u0000${source.sha256}\u0000${variant}`;

interface Job {
  key: string;
  source: AttachmentSource;
  variant: ImageVariant;
  weight: number;
  consumers: number;
  attempts: number;
  controller: AbortController;
  promise: Promise<Blob>;
  resolve(blob: Blob): void;
  reject(error: unknown): void;
  cancelRetry?: (() => void) | undefined;
}
export interface ImageLease {
  promise: Promise<Blob>;
  release(): void;
}

/** One connection's shared image reads. Jobs retain metadata until admitted, never image bytes.
 * Two reads match the daemon decoder budget; originals also share a 32 MiB in-flight budget.
 * The 64-job cap includes delayed retries. Only mounted consumers retain an unfinished job.
 */
export class AttachmentLoads {
  private blobs = new LruCache<string, Blob>({
    maxEntries: 96,
    maxWeight: 48 * 1024 * 1024,
    weigh: (blob) => blob.size,
  });
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active = 0;
  private weight = 0;
  private client: ClientApi;
  private schedule: (delay: number, callback: () => void) => () => void;
  constructor(client: ClientApi, schedule: (delay: number, callback: () => void) => () => void) {
    this.client = client;
    this.schedule = schedule;
  }
  cached(source: AttachmentSource, variant: ImageVariant): Blob | undefined {
    return this.blobs.get(keyOf(source, variant));
  }
  acquire(source: AttachmentSource, variant: ImageVariant): ImageLease {
    const key = keyOf(source, variant);
    const hit = this.blobs.get(key);
    if (hit) return { promise: Promise.resolve(hit), release() {} };
    let job = this.jobs.get(key);
    if (!job) {
      const weight = variant === "thumbnail" ? thumbnailLimit : source.bytes;
      if (
        this.jobs.size >= 64 ||
        !Number.isSafeInteger(weight) ||
        weight <= 0 ||
        weight > originalLimit
      )
        return { promise: Promise.reject(new ClientError("limit")), release() {} };
      const result = Promise.withResolvers<Blob>();
      job = {
        key,
        source,
        variant,
        weight,
        consumers: 0,
        attempts: 0,
        controller: new AbortController(),
        ...result,
      };
      this.jobs.set(key, job);
      this.queue.push(job);
    }
    const target = job;
    target.consumers++;
    this.drain();
    let released = false;
    return {
      promise: target.promise,
      release: () => {
        if (released) return;
        released = true;
        if (--target.consumers || this.jobs.get(key) !== target) return;
        this.jobs.delete(key);
        this.queue = this.queue.filter((queued) => queued !== target);
        target.cancelRetry?.();
        target.controller.abort();
        target.reject(new ClientError("aborted"));
        this.drain();
      },
    };
  }
  private drain(): void {
    while (this.active < 2 && this.queue.length) {
      // FIFO keeps large originals from starving behind a continuous stream of thumbnails.
      const job = this.queue[0];
      if (!job || this.weight + job.weight > originalLimit) return;
      this.queue.shift();
      job.attempts++;
      this.active++;
      this.weight += job.weight;
      void this.read(job);
    }
  }
  private async read(job: Job): Promise<void> {
    try {
      const { bytes, mimeType } = await this.client.attachmentBytes(
        {
          threadId: job.source.threadId,
          sha256: job.source.sha256,
          variant: job.variant,
          ...(job.variant === "original" ? { maxBytes: job.weight } : {}),
        },
        { signal: job.controller.signal },
      );
      if (this.jobs.get(job.key) !== job) return;
      // Client reads own their ArrayBuffer. Blob snapshots it, so no extra full-array slice
      // is needed. Keep a bounded copy fallback for an alternative client's shared buffer.
      const part =
        bytes.buffer instanceof ArrayBuffer
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : bytes.slice();
      const blob = new Blob([part], { type: mimeType });
      this.blobs.set(job.key, blob);
      this.jobs.delete(job.key);
      job.resolve(blob);
    } catch (error) {
      if (this.jobs.get(job.key) !== job) return;
      // Other connections share the daemon decoder and socket queue. Retry their temporary
      // admission failure, but bound both attempts and retained jobs. Release capacity first.
      if (error instanceof ClientError && error.code === "busy" && job.attempts < 4) {
        job.cancelRetry = this.schedule(100 * job.attempts, () => {
          job.cancelRetry = undefined;
          if (this.jobs.get(job.key) !== job) return;
          this.queue.push(job);
          this.drain();
        });
      } else {
        this.jobs.delete(job.key);
        job.reject(error);
      }
    } finally {
      this.active--;
      this.weight -= job.weight;
      this.drain();
    }
  }
}
