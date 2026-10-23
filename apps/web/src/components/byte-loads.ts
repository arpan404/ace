import { ClientError, type ClientApi } from "@ace/client";
import { LruCache } from "@ace/ui-core";

const attempts = 4;

/**
 * Whether a failed read can never succeed by asking again: the bytes are gone or refused, or
 * the daemon speaks another protocol. Everything else (a dropped or reconnecting socket, a
 * deadline on a slow link, a busy decoder or channel) is transient and is retried.
 */
export function permanentFailure(error: unknown): boolean {
  if (!(error instanceof ClientError)) return false;
  if (error.code === "daemon") return ["NOT_FOUND", "FORBIDDEN", "QUOTA"].includes(error.message);
  return ["protocol", "version_mismatch", "identity", "auth"].includes(error.code);
}

export interface ByteLoadsOptions<Target> {
  key(target: Target): string;
  /** What a read holds of the in-flight budget while it runs (its byte budget). */
  weight(target: Target): number;
  read(target: Target, signal: AbortSignal): Promise<Blob>;
  /** Reads at once, and the bytes they may hold together. */
  concurrency: number;
  budget: number;
  /** What finished reads are kept, by count and bytes. */
  kept: { maxEntries: number; maxWeight: number };
}

interface Job<Target> {
  key: string;
  target: Target;
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

/** One connection's shared byte reads. Jobs retain metadata until admitted, never bytes.
 * Reads run a few at a time within a shared in-flight budget; the 64-job cap includes delayed
 * retries. Only mounted consumers retain an unfinished job. While the connection is not ready
 * (a phone asleep, a reconnect) jobs wait for it instead of failing, and a transient failure is
 * retried with backoff before it is reported.
 */
export class ByteLoads<Target> {
  private blobs: LruCache<string, Blob>;
  private jobs = new Map<string, Job<Target>>();
  private queue: Job<Target>[] = [];
  private active = 0;
  private weight = 0;
  private client: ClientApi;
  private schedule: (delay: number, callback: () => void) => () => void;
  private options: ByteLoadsOptions<Target>;
  private stopWaiting: (() => void) | undefined;
  constructor(
    client: ClientApi,
    schedule: (delay: number, callback: () => void) => () => void,
    options: ByteLoadsOptions<Target>,
  ) {
    this.client = client;
    this.schedule = schedule;
    this.options = options;
    this.blobs = new LruCache<string, Blob>({ ...options.kept, weigh: (blob) => blob.size });
  }
  cached(target: Target): Blob | undefined {
    return this.blobs.get(this.options.key(target));
  }
  /** Forget kept bytes the browser could not show, so the next read asks the daemon again. */
  evict(target: Target): void {
    this.blobs.delete(this.options.key(target));
  }
  acquire(target: Target): ImageLease {
    const key = this.options.key(target);
    const hit = this.blobs.get(key);
    if (hit) return { promise: Promise.resolve(hit), release() {} };
    let job = this.jobs.get(key);
    if (!job) {
      const weight = this.options.weight(target);
      if (
        this.jobs.size >= 64 ||
        !Number.isSafeInteger(weight) ||
        weight <= 0 ||
        weight > this.options.budget
      )
        return { promise: Promise.reject(new ClientError("limit")), release() {} };
      const result = Promise.withResolvers<Blob>();
      job = {
        key,
        target,
        weight,
        consumers: 0,
        attempts: 0,
        controller: new AbortController(),
        ...result,
      };
      this.jobs.set(key, job);
      this.queue.push(job);
    }
    const queued = job;
    queued.consumers++;
    this.drain();
    let released = false;
    return {
      promise: queued.promise,
      release: () => {
        if (released) return;
        released = true;
        if (--queued.consumers || this.jobs.get(key) !== queued) return;
        this.jobs.delete(key);
        this.queue = this.queue.filter((entry) => entry !== queued);
        queued.cancelRetry?.();
        queued.controller.abort();
        queued.reject(new ClientError("aborted"));
        this.drain();
      },
    };
  }
  private drain(): void {
    if (this.queue.length && this.reconnecting()) {
      this.waitForReady();
      return;
    }
    while (this.active < this.options.concurrency && this.queue.length) {
      // FIFO keeps large reads from starving behind a continuous stream of small ones.
      const job = this.queue[0];
      if (!job || this.weight + job.weight > this.options.budget) return;
      this.queue.shift();
      job.attempts++;
      this.active++;
      this.weight += job.weight;
      void this.read(job);
    }
  }
  private async read(job: Job<Target>): Promise<void> {
    try {
      const blob = await this.options.read(job.target, job.controller.signal);
      if (this.jobs.get(job.key) !== job) return;
      this.blobs.set(job.key, blob);
      this.jobs.delete(job.key);
      job.resolve(blob);
    } catch (error) {
      if (this.jobs.get(job.key) !== job) return;
      if (!permanentFailure(error) && this.reconnecting()) {
        // The connection dropped under the read; it resumes once the connection is back.
        job.attempts--;
        this.queue.push(job);
      } else if (!permanentFailure(error) && job.attempts < attempts) {
        // Bound both attempts and retained jobs. Release capacity first.
        job.cancelRetry = this.schedule(100 * 2 ** (job.attempts - 1), () => {
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
  /** Not ready yet, but coming back; a fatal connection reports its reads as failed. */
  private reconnecting(): boolean {
    return this.client.state !== "ready" && this.client.state !== "fatal";
  }
  private waitForReady(): void {
    if (this.stopWaiting) return;
    const selection = this.client.connectionState();
    const stop = selection.subscribe(() => {
      if (this.client.state !== "ready") return;
      stop();
      this.stopWaiting = undefined;
      this.drain();
    });
    this.stopWaiting = stop;
  }
}
