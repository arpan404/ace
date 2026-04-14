import type {
  ProviderKind,
  ServerRuntimeProfile,
  ServerRuntimeProfileProviderRuntimeIngestionCaches,
  ServerRuntimeProfileSnapshotViewCache,
} from "@ace/contracts";

const providerRuntimeIngestionCaches: ServerRuntimeProfileProviderRuntimeIngestionCaches = {
  activeAssistantStreams: 0,
  assistantOutputSeenStreams: 0,
  pendingAssistantDeltaStreams: 0,
  bufferedThinkingActivities: 0,
  lastActivityFingerprints: 0,
  trackedSessionPids: 0,
  queueCapacity: 0,
};

const snapshotViewCache: ServerRuntimeProfileSnapshotViewCache = {
  maxEntries: 0,
  currentEntries: 0,
};

function asNonNegativeInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

export function updateProviderRuntimeIngestionCacheStats(
  patch: Partial<ServerRuntimeProfileProviderRuntimeIngestionCaches>,
): void {
  Object.assign(providerRuntimeIngestionCaches, {
    ...providerRuntimeIngestionCaches,
    ...Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, asNonNegativeInt(value)]),
    ),
  });
}

export function updateSnapshotViewCacheStats(
  patch: Partial<ServerRuntimeProfileSnapshotViewCache>,
): void {
  Object.assign(snapshotViewCache, {
    ...snapshotViewCache,
    ...Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, asNonNegativeInt(value)]),
    ),
  });
}

export function collectRuntimeProfileSnapshot(input?: {
  providerSessions?: ReadonlyArray<{ provider: ProviderKind; sessionCount: number }>;
}): ServerRuntimeProfile {
  const memoryUsage = process.memoryUsage();
  const pid = process.pid;
  const generatedAt = new Date().toISOString();

  return {
    generatedAt,
    process: {
      pid,
      platform: process.platform,
      nodeVersion: process.version,
      uptimeSeconds: process.uptime(),
      rssBytes: asNonNegativeInt(memoryUsage.rss),
      heapUsedBytes: asNonNegativeInt(memoryUsage.heapUsed),
      heapTotalBytes: asNonNegativeInt(memoryUsage.heapTotal),
      externalBytes: asNonNegativeInt(memoryUsage.external),
      arrayBuffersBytes: asNonNegativeInt(memoryUsage.arrayBuffers),
    },
    caches: {
      snapshotView: {
        maxEntries: snapshotViewCache.maxEntries,
        currentEntries: snapshotViewCache.currentEntries,
      },
      providerRuntimeIngestion: {
        activeAssistantStreams: providerRuntimeIngestionCaches.activeAssistantStreams,
        assistantOutputSeenStreams: providerRuntimeIngestionCaches.assistantOutputSeenStreams,
        pendingAssistantDeltaStreams: providerRuntimeIngestionCaches.pendingAssistantDeltaStreams,
        bufferedThinkingActivities: providerRuntimeIngestionCaches.bufferedThinkingActivities,
        lastActivityFingerprints: providerRuntimeIngestionCaches.lastActivityFingerprints,
        trackedSessionPids: providerRuntimeIngestionCaches.trackedSessionPids,
        queueCapacity: providerRuntimeIngestionCaches.queueCapacity,
      },
    },
    providerSessions:
      input?.providerSessions?.map((entry) => ({
        provider: entry.provider,
        sessionCount: asNonNegativeInt(entry.sessionCount),
      })) ?? [],
  };
}
