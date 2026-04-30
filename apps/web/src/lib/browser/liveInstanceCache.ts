export interface RecentBrowserInstanceEntry<T extends string> {
  readonly instanceId: T;
  readonly lastOpenedAt: number;
}

export function touchRecentBrowserInstance<T extends string>(
  currentEntries: readonly RecentBrowserInstanceEntry<T>[],
  instanceId: T,
  touchedAt: number,
  maxEntries: number,
): RecentBrowserInstanceEntry<T>[] {
  if (maxEntries <= 0) {
    return [];
  }

  return [
    {
      instanceId,
      lastOpenedAt: touchedAt,
    },
    ...currentEntries.filter((entry) => entry.instanceId !== instanceId),
  ].slice(0, maxEntries);
}

export function removeRecentBrowserInstance<T extends string>(
  currentEntries: readonly RecentBrowserInstanceEntry<T>[],
  instanceId: T,
): RecentBrowserInstanceEntry<T>[] {
  return currentEntries.filter((entry) => entry.instanceId !== instanceId);
}

export function evictExpiredRecentBrowserInstances<T extends string>(
  currentEntries: readonly RecentBrowserInstanceEntry<T>[],
  now: number,
  ttlMs: number,
  protectedInstanceId?: T | null,
): RecentBrowserInstanceEntry<T>[] {
  if (ttlMs <= 0) {
    return protectedInstanceId
      ? currentEntries.filter((entry) => entry.instanceId === protectedInstanceId)
      : [];
  }

  return currentEntries.filter(
    (entry) => entry.instanceId === protectedInstanceId || now - entry.lastOpenedAt < ttlMs,
  );
}

export function resolveNextRecentBrowserInstanceExpiry<T extends string>(
  currentEntries: readonly RecentBrowserInstanceEntry<T>[],
  ttlMs: number,
  protectedInstanceId?: T | null,
): number | null {
  if (ttlMs <= 0) {
    return null;
  }

  let nextExpiryAt: number | null = null;
  for (const entry of currentEntries) {
    if (entry.instanceId === protectedInstanceId) {
      continue;
    }

    const expiresAt = entry.lastOpenedAt + ttlMs;
    if (nextExpiryAt === null || expiresAt < nextExpiryAt) {
      nextExpiryAt = expiresAt;
    }
  }

  return nextExpiryAt;
}
