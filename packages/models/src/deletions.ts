import type { CatalogStorage } from "./types.ts";

/**
 * At most one pending deletion per row the catalog can name: every registered row and every
 * cached one (64 CLI accounts and 512 ACP agents' rows each, `catalog.ts`). A restart that finds
 * every cached row out of date deletes them all without refusing a registration.
 */
const pendingLimit = 2 * (64 + 512);
/** Deletions sent to storage at once, well inside its write queue (128) for other writes. */
const inFlightLimit = 32;

/** Keep failed deletions until an explicit retry or shutdown durably completes them. */
export class PendingDeletions {
  readonly #pending = new Map<string, Promise<void> | undefined>();
  readonly #storage: CatalogStorage;
  #inFlight = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(storage: CatalogStorage) {
    this.#storage = storage;
  }
  has(instance: string): boolean {
    return this.#pending.has(instance);
  }
  remove(instance: string): Promise<void> {
    const existing = this.#pending.get(instance);
    if (existing) return existing;
    if (!this.#pending.has(instance) && this.#pending.size >= pendingLimit)
      throw new Error("Persistence queue full");
    const pending = this.#send(instance);
    this.#pending.set(instance, pending);
    void pending.then(
      () => this.#pending.delete(instance),
      () => this.#pending.set(instance, undefined),
    );
    return pending;
  }
  /** One deletion, in turn: a finished one hands its slot straight to the next waiting. */
  async #send(instance: string): Promise<void> {
    if (this.#inFlight < inFlightLimit) this.#inFlight++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      await Promise.resolve();
      await this.#storage.remove(instance);
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#inFlight--;
    }
  }
  retry(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([...this.#pending.keys()].map((instance) => this.remove(instance)));
  }
  async flush(): Promise<void> {
    const results = await this.retry();
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Model persistence deletion failed");
  }
}
