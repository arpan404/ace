/** One Usage row's size: `undefined` while it is unknown or still being measured. */
export type UsageEntry<Key> = { key: Key; bytes: number | undefined };

/** A row in display order with its bar length, 0–1 of the largest row; `undefined` when unsized. */
export type UsageBar<Key> = UsageEntry<Key> & { share: number | undefined };

/**
 * Orders Usage rows largest first and scales each bar against the largest row. Rows of equal
 * size keep their given order; unsized rows follow every sized one, also in their given order.
 */
export function usageBars<Key>(entries: readonly UsageEntry<Key>[]): UsageBar<Key>[] {
  const sized = entries.filter((entry) => entry.bytes !== undefined);
  const unsized = entries.filter((entry) => entry.bytes === undefined);
  const largest = Math.max(0, ...sized.map((entry) => entry.bytes ?? 0));
  const ordered = sized.toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  return [
    ...ordered.map((entry) => ({
      ...entry,
      share: largest > 0 ? (entry.bytes ?? 0) / largest : 0,
    })),
    ...unsized.map((entry) => ({ ...entry, share: undefined })),
  ];
}
