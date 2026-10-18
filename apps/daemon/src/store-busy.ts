/** SQLite contention is transient; an admission retry must precede stateful translation. */
export function isStoreBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("errcode" in error && (error.errcode === 5 || error.errcode === 6)) ||
      error.message === "Store is busy")
  );
}

/**
 * Writes wait while a pinned live-write batch retries after a failure that is not contention.
 * The batch heals or is quarantined on its own backoff; the real failure is the `cause`.
 */
export class LiveWriteRetry extends Error {
  constructor(cause: unknown) {
    super("Live writes are retrying a failed batch", { cause });
    this.name = "LiveWriteRetry";
  }
}

/** Whether a write failed only for now and the same operation may be retried later. */
export function isStoreRetry(error: unknown): boolean {
  return isStoreBusy(error) || error instanceof LiveWriteRetry;
}
