import { type OrchestrationReadModel, type ThreadId } from "@ace/contracts";
import { DEFAULT_THREAD_HYDRATION_CACHE_MEMORY_MB } from "@ace/contracts/settings";

import { ensureNativeApi } from "../nativeApi";
import { runAsyncTask } from "./async";
import { LRUCache } from "./lruCache";
import { registerMemoryPressureHandler, shouldBypassNonEssentialCaching } from "./memoryPressure";
import {
  clampCacheBudgetBytes,
  clampCacheEntryCount,
  shouldAvoidSpeculativeWork,
} from "./resourceProfile";

type HydratedReadModelThread = OrchestrationReadModel["threads"][number];

interface HydratedThreadCacheEntry {
  readonly updatedAt: string;
  readonly thread: HydratedReadModelThread;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_MAX_CACHED_THREADS = 256;
const DEFAULT_CACHE_MEMORY_BYTES = DEFAULT_THREAD_HYDRATION_CACHE_MEMORY_MB * BYTES_PER_MEGABYTE;
const MODERATE_DEVICE_MAX_CACHED_THREADS = 128;
const CONSTRAINED_DEVICE_MAX_CACHED_THREADS = 64;
const MODERATE_DEVICE_CACHE_MEMORY_BYTES = 64 * BYTES_PER_MEGABYTE;
const CONSTRAINED_DEVICE_CACHE_MEMORY_BYTES = 32 * BYTES_PER_MEGABYTE;
const BACKGROUND_PREFETCH_TIMEOUT_MS = 750;
const BACKGROUND_PREFETCH_FALLBACK_DELAY_MS = 120;
const INITIAL_THREAD_HYDRATION_RETRY_DELAY_MS = 500;
const MAX_THREAD_HYDRATION_RETRY_DELAY_MS = 10_000;

export interface ThreadHydrationCacheConfig {
  readonly maxEntries?: number;
  readonly maxMemoryBytes?: number;
}

interface ResolvedThreadHydrationCacheConfig {
  readonly maxEntries: number;
  readonly maxMemoryBytes: number;
}

type ThreadHydrationOptions = {
  readonly expectedUpdatedAt?: string | null;
};

export function resolveThreadHydrationRetryDelayMs(failureCount: number): number {
  return Math.min(
    MAX_THREAD_HYDRATION_RETRY_DELAY_MS,
    INITIAL_THREAD_HYDRATION_RETRY_DELAY_MS * 2 ** Math.max(0, failureCount - 1),
  );
}

type ScheduledPrefetchHandle =
  | {
      readonly kind: "idle";
      readonly handle: number;
    }
  | {
      readonly kind: "timeout";
      readonly handle: ReturnType<typeof setTimeout>;
    };

function estimateHydratedThreadSize(thread: HydratedReadModelThread): number {
  return (
    512 +
    thread.title.length * 2 +
    thread.messages.reduce(
      (size, message) =>
        size + 192 + message.text.length * 2 + (message.attachments?.length ?? 0) * 256,
      0,
    ) +
    thread.activities.reduce((size, activity) => size + 160 + activity.summary.length * 2, 0) +
    thread.proposedPlans.reduce((size, plan) => size + 160 + plan.planMarkdown.length * 2, 0) +
    thread.checkpoints.length * 192
  );
}

function resolveThreadHydrationCacheConfig(
  config?: ThreadHydrationCacheConfig,
): ResolvedThreadHydrationCacheConfig {
  const requestedMaxEntries = Math.max(
    1,
    Math.trunc(config?.maxEntries ?? DEFAULT_MAX_CACHED_THREADS),
  );
  const requestedMaxMemoryBytes = Math.max(
    BYTES_PER_MEGABYTE,
    Math.trunc(config?.maxMemoryBytes ?? DEFAULT_CACHE_MEMORY_BYTES),
  );
  const maxEntries = clampCacheEntryCount(requestedMaxEntries, {
    moderateCapEntries: MODERATE_DEVICE_MAX_CACHED_THREADS,
    constrainedCapEntries: CONSTRAINED_DEVICE_MAX_CACHED_THREADS,
  });
  const maxMemoryBytes = clampCacheBudgetBytes(requestedMaxMemoryBytes, {
    moderateCapBytes: MODERATE_DEVICE_CACHE_MEMORY_BYTES,
    constrainedCapBytes: CONSTRAINED_DEVICE_CACHE_MEMORY_BYTES,
  });
  return {
    maxEntries,
    maxMemoryBytes,
  };
}

function cancelScheduledPrefetch(handle: ScheduledPrefetchHandle): void {
  if (handle.kind === "idle") {
    if (typeof cancelIdleCallback === "function") {
      cancelIdleCallback(handle.handle);
    }
    return;
  }

  clearTimeout(handle.handle);
}

export interface ThreadHydrationCache {
  readonly read: (
    threadId: ThreadId,
    expectedUpdatedAt?: string | null,
  ) => HydratedReadModelThread | null;
  readonly prime: (thread: HydratedReadModelThread) => HydratedReadModelThread;
  readonly hydrate: (
    threadId: ThreadId,
    options?: ThreadHydrationOptions,
  ) => Promise<HydratedReadModelThread>;
  readonly prefetch: (
    threadId: ThreadId,
    options?: ThreadHydrationOptions & {
      readonly priority?: "background" | "immediate";
    },
  ) => void;
  readonly releaseMemory: () => void;
  readonly clear: () => void;
}

export function createThreadHydrationCache(
  fetchThread: (threadId: ThreadId) => Promise<HydratedReadModelThread>,
  config?: ThreadHydrationCacheConfig,
): ThreadHydrationCache {
  const resolvedConfig = resolveThreadHydrationCacheConfig(config);
  const cache = new LRUCache<HydratedThreadCacheEntry>(
    resolvedConfig.maxEntries,
    resolvedConfig.maxMemoryBytes,
  );
  const inFlightByThreadId = new Map<ThreadId, Promise<HydratedReadModelThread>>();
  const scheduledPrefetchByThreadId = new Map<ThreadId, ScheduledPrefetchHandle>();

  const read = (
    threadId: ThreadId,
    expectedUpdatedAt?: string | null,
  ): HydratedReadModelThread | null => {
    const cached = cache.get(threadId);
    if (!cached) {
      return null;
    }
    if (
      expectedUpdatedAt !== undefined &&
      expectedUpdatedAt !== null &&
      cached.updatedAt !== expectedUpdatedAt
    ) {
      return null;
    }
    return cached.thread;
  };

  const prime = (thread: HydratedReadModelThread): HydratedReadModelThread => {
    if (shouldBypassNonEssentialCaching()) {
      return thread;
    }
    cache.set(
      thread.id,
      {
        updatedAt: thread.updatedAt,
        thread,
      },
      estimateHydratedThreadSize(thread),
    );
    return thread;
  };

  const hydrate = async (
    threadId: ThreadId,
    options?: ThreadHydrationOptions,
  ): Promise<HydratedReadModelThread> => {
    const cached = read(threadId, options?.expectedUpdatedAt);
    if (cached) {
      return cached;
    }

    const existing = inFlightByThreadId.get(threadId);
    if (existing) {
      return existing;
    }

    const request = fetchThread(threadId)
      .then((thread) => prime(thread))
      .finally(() => {
        if (inFlightByThreadId.get(threadId) === request) {
          inFlightByThreadId.delete(threadId);
        }
      });
    inFlightByThreadId.set(threadId, request);
    return request;
  };

  const startPrefetch = (threadId: ThreadId, options?: ThreadHydrationOptions): void => {
    if (read(threadId, options?.expectedUpdatedAt) || inFlightByThreadId.has(threadId)) {
      return;
    }
    runAsyncTask(hydrate(threadId, options), "Failed to prefetch hydrated thread data.");
  };

  const prefetch = (
    threadId: ThreadId,
    options?: ThreadHydrationOptions & {
      readonly priority?: "background" | "immediate";
    },
  ): void => {
    const priority = options?.priority ?? "background";
    const existingScheduledPrefetch = scheduledPrefetchByThreadId.get(threadId);
    if (existingScheduledPrefetch) {
      cancelScheduledPrefetch(existingScheduledPrefetch);
      scheduledPrefetchByThreadId.delete(threadId);
    }

    if (priority === "immediate") {
      startPrefetch(threadId, options);
      return;
    }

    if (shouldAvoidSpeculativeWork()) {
      return;
    }

    if (read(threadId, options?.expectedUpdatedAt) || inFlightByThreadId.has(threadId)) {
      return;
    }

    const scheduledOptions =
      options?.expectedUpdatedAt === undefined
        ? undefined
        : { expectedUpdatedAt: options.expectedUpdatedAt };
    const runPrefetch = () => {
      scheduledPrefetchByThreadId.delete(threadId);
      startPrefetch(threadId, scheduledOptions);
    };

    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(runPrefetch, {
        timeout: BACKGROUND_PREFETCH_TIMEOUT_MS,
      });
      scheduledPrefetchByThreadId.set(threadId, {
        kind: "idle",
        handle,
      });
      return;
    }

    const handle = setTimeout(runPrefetch, BACKGROUND_PREFETCH_FALLBACK_DELAY_MS);
    scheduledPrefetchByThreadId.set(threadId, {
      kind: "timeout",
      handle,
    });
  };

  const releaseMemory = () => {
    for (const handle of scheduledPrefetchByThreadId.values()) {
      cancelScheduledPrefetch(handle);
    }
    scheduledPrefetchByThreadId.clear();
    cache.clear();
  };

  const clear = () => {
    releaseMemory();
    inFlightByThreadId.clear();
  };

  return {
    read,
    prime,
    hydrate,
    prefetch,
    releaseMemory,
    clear,
  };
}

function createSharedThreadHydrationCache(
  config?: ThreadHydrationCacheConfig,
): ThreadHydrationCache {
  return createThreadHydrationCache(
    (threadId) => ensureNativeApi().orchestration.getThread({ threadId }),
    config,
  );
}

let sharedThreadHydrationCacheConfig = resolveThreadHydrationCacheConfig();
let sharedThreadHydrationCache = createSharedThreadHydrationCache(sharedThreadHydrationCacheConfig);

registerMemoryPressureHandler({
  id: "thread-hydration-cache",
  minLevel: "high",
  release: () => {
    sharedThreadHydrationCache.releaseMemory();
  },
});

export function configureThreadHydrationCache(config?: ThreadHydrationCacheConfig): void {
  const nextConfig = resolveThreadHydrationCacheConfig(config);
  if (
    nextConfig.maxEntries === sharedThreadHydrationCacheConfig.maxEntries &&
    nextConfig.maxMemoryBytes === sharedThreadHydrationCacheConfig.maxMemoryBytes
  ) {
    return;
  }

  sharedThreadHydrationCacheConfig = nextConfig;
  sharedThreadHydrationCache = createSharedThreadHydrationCache(sharedThreadHydrationCacheConfig);
}

export function readCachedHydratedThread(
  threadId: ThreadId,
  expectedUpdatedAt?: string | null,
): HydratedReadModelThread | null {
  return sharedThreadHydrationCache.read(threadId, expectedUpdatedAt);
}

export function primeHydratedThreadCache(thread: HydratedReadModelThread): HydratedReadModelThread {
  return sharedThreadHydrationCache.prime(thread);
}

export function hydrateThreadFromCache(
  threadId: ThreadId,
  options?: ThreadHydrationOptions,
): Promise<HydratedReadModelThread> {
  return sharedThreadHydrationCache.hydrate(threadId, options);
}

export function prefetchHydratedThread(
  threadId: ThreadId,
  options?: ThreadHydrationOptions & {
    readonly priority?: "background" | "immediate";
  },
): void {
  sharedThreadHydrationCache.prefetch(threadId, options);
}

export function __resetThreadHydrationCacheForTests(): void {
  sharedThreadHydrationCacheConfig = resolveThreadHydrationCacheConfig();
  sharedThreadHydrationCache = createSharedThreadHydrationCache(sharedThreadHydrationCacheConfig);
}
