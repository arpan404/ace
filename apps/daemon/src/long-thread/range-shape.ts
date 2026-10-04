/** Seven radix-256 levels cover every exactly representable nonnegative integer. */
export function rangeBuckets(position: number): { level: number; bucket: number }[] {
  const value = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(position)));
  return Array.from({ length: 7 }, (_, level) => ({
    level,
    bucket: Math.floor(value / 2 ** (8 * level)),
  }));
}

/** Disjoint subtrees covering positions <= cutoff; each level visits at most 256 buckets. */
export function rangePrefix(cutoff: number): { level: number; low: number; high: number }[] {
  return rangeBuckets(cutoff).map(({ level, bucket }) => ({
    level,
    low: Math.floor(bucket / 256) * 256,
    high: bucket + Number(level === 0),
  }));
}

/** The complementary disjoint subtrees for positions strictly greater than cutoff. */
export function rangeSuffix(cutoff: number): { level: number; low: number; high: number }[] {
  return rangeBuckets(cutoff).map(({ level, bucket }) => ({
    level,
    low: bucket + 1,
    high: level === 6 ? 32 : (Math.floor(bucket / 256) + 1) * 256,
  }));
}
