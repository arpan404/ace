import type { CatalogStorage } from "./types.ts";

/** Keep failed deletions until an explicit retry or shutdown durably completes them. */
export class PendingDeletions {
  readonly #pending = new Map<string, Promise<void> | undefined>();
  readonly #storage: CatalogStorage;
  constructor(storage: CatalogStorage) {
    this.#storage = storage;
  }
  has(instance: string): boolean {
    return this.#pending.has(instance);
  }
  remove(instance: string): Promise<void> {
    const existing = this.#pending.get(instance);
    if (existing) return existing;
    if (!this.#pending.has(instance) && this.#pending.size >= 128)
      throw new Error("Persistence queue full");
    const pending = Promise.resolve().then(() => this.#storage.remove(instance));
    this.#pending.set(instance, pending);
    void pending.then(
      () => this.#pending.delete(instance),
      () => this.#pending.set(instance, undefined),
    );
    return pending;
  }
  async flush(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#pending.keys()].map((instance) => this.remove(instance)),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Model persistence deletion failed");
  }
}
