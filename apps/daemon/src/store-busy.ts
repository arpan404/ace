/** SQLite contention is transient; an admission retry must precede stateful translation. */
export function isStoreBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("errcode" in error && (error.errcode === 5 || error.errcode === 6)) ||
      error.message === "Store is busy")
  );
}
