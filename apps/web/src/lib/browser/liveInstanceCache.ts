export function touchRecentBrowserInstanceId<T extends string>(
  currentIds: readonly T[],
  instanceId: T,
  maxEntries: number,
): T[] {
  if (maxEntries <= 0) {
    return [];
  }
  return [instanceId, ...currentIds.filter((currentId) => currentId !== instanceId)].slice(
    0,
    maxEntries,
  );
}

export function removeRecentBrowserInstanceId<T extends string>(
  currentIds: readonly T[],
  instanceId: T,
): T[] {
  return currentIds.filter((currentId) => currentId !== instanceId);
}
