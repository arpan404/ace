/** One small usage snapshot per connection; cleanup plans are never retained with it. */
export const storageUsageKey = ["storage", "usage"] as const;
export const storageUsageGcMs = 24 * 60 * 60_000;
/** Normal reads are cheap daemon snapshot reads, not forced disk measurements. */
export const storageUsageStaleMs = 60_000;

export function storageUsageQuery(key: readonly unknown[]): boolean {
  return (
    key.length === storageUsageKey.length && storageUsageKey.every((part, i) => key[i] === part)
  );
}
