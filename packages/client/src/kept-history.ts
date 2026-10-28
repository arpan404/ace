import { z } from "zod";
import { ClientError } from "./types.ts";
import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
import { snapshotRetention } from "./snapshot-retention.ts";

const Envelope = z.object({
  version: z.literal(1),
  saved: z.number().finite(),
  value: z.unknown(),
});

/** Disk reads are optional and never authoritative. The caller validates the current revision. */
export class KeptHistory {
  #storage: ReadSnapshotStorage;
  #now: () => number;
  #epoch = 0;
  #threads = new Map<string, number>();

  constructor(storage: ReadSnapshotStorage, now: () => number) {
    this.#storage = storage;
    this.#now = now;
  }

  async read<T>(
    scope: string,
    query: string,
    schema: z.ZodType<T>,
    accept: (value: T) => boolean,
    load: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const entry = this.entry(scope, query, schema, accept, signal);
    const kept = await entry.get();
    if (kept !== undefined) return kept;
    const value = await load();
    await entry.set(value);
    return value;
  }

  /** A generation-bound entry, also used by streaming readers that save only on completion. */
  entry<T>(
    scope: string,
    query: string,
    schema: z.ZodType<T>,
    accept: (value: T) => boolean,
    signal?: AbortSignal,
  ) {
    const epoch = this.#epoch;
    const generation = this.#threads.get(scope) ?? 0;
    const current = () => epoch === this.#epoch && generation === (this.#threads.get(scope) ?? 0);
    const key = `history/${encodeURIComponent(scope)}/${query}`;
    return {
      get: async (): Promise<T | undefined> => {
        if (signal?.aborted) throw new ClientError("aborted");
        let kept: T | undefined;
        try {
          const record = Envelope.safeParse(await this.#storage.get(key));
          if (current() && record.success) {
            const age = this.#now() - record.data.saved;
            if (age >= 0 && age < snapshotRetention.maxAgeMs) {
              const value = schema.safeParse(record.data.value);
              if (value.success && accept(value.data)) kept = value.data;
            }
          }
        } catch {
          // Storage failure is a miss.
        }
        if (signal?.aborted) throw new ClientError("aborted");
        return kept;
      },
      set: async (value: T): Promise<void> => {
        if (!current() || signal?.aborted) return;
        try {
          await this.#storage.set(key, { version: 1, saved: this.#now(), value });
        } catch {
          // A successful daemon read remains usable if the disk is full.
        }
      },
    };
  }

  clear(): void {
    this.#epoch++;
    this.#threads.clear();
  }

  forget(scope: string): Promise<void> {
    this.#threads.set(scope, (this.#threads.get(scope) ?? 0) + 1);
    return (
      this.#storage.deletePrefix?.(`history/${encodeURIComponent(scope)}/`) ?? Promise.resolve()
    );
  }
}
