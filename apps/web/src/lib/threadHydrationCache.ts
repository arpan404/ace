import { type OrchestrationReadModel, type ThreadId } from "@t3tools/contracts";

import { ensureNativeApi } from "../nativeApi";
import { LRUCache } from "./lruCache";

type HydratedReadModelThread = OrchestrationReadModel["threads"][number];

interface HydratedThreadCacheEntry {
  readonly updatedAt: string;
  readonly thread: HydratedReadModelThread;
}

const MAX_CACHED_THREADS = 12;
const MAX_CACHE_MEMORY_BYTES = 16 * 1024 * 1024;

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

function findReadModelThread(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): HydratedReadModelThread {
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (!thread || thread.deletedAt !== null) {
    throw new Error(`Thread ${threadId} is unavailable.`);
  }
  return thread;
}

export interface ThreadHydrationCache {
  readonly read: (
    threadId: ThreadId,
    expectedUpdatedAt?: string | null,
  ) => HydratedReadModelThread | null;
  readonly prime: (thread: HydratedReadModelThread) => HydratedReadModelThread;
  readonly hydrate: (
    threadId: ThreadId,
    options?: { readonly expectedUpdatedAt?: string | null },
  ) => Promise<HydratedReadModelThread>;
  readonly prefetch: (
    threadId: ThreadId,
    options?: { readonly expectedUpdatedAt?: string | null },
  ) => void;
  readonly clear: () => void;
}

export function createThreadHydrationCache(
  fetchThread: (threadId: ThreadId) => Promise<HydratedReadModelThread>,
): ThreadHydrationCache {
  const cache = new LRUCache<HydratedThreadCacheEntry>(MAX_CACHED_THREADS, MAX_CACHE_MEMORY_BYTES);
  const inFlightByThreadId = new Map<ThreadId, Promise<HydratedReadModelThread>>();

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
    options?: { readonly expectedUpdatedAt?: string | null },
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

  const prefetch = (
    threadId: ThreadId,
    options?: { readonly expectedUpdatedAt?: string | null },
  ): void => {
    void hydrate(threadId, options).catch(() => undefined);
  };

  const clear = () => {
    inFlightByThreadId.clear();
    cache.clear();
  };

  return {
    read,
    prime,
    hydrate,
    prefetch,
    clear,
  };
}

const sharedThreadHydrationCache = createThreadHydrationCache(async (threadId) => {
  const snapshot = await ensureNativeApi().orchestration.getSnapshot({
    hydrateThreadId: threadId,
  });
  return findReadModelThread(snapshot, threadId);
});

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
  options?: { readonly expectedUpdatedAt?: string | null },
): Promise<HydratedReadModelThread> {
  return sharedThreadHydrationCache.hydrate(threadId, options);
}

export function prefetchHydratedThread(
  threadId: ThreadId,
  options?: { readonly expectedUpdatedAt?: string | null },
): void {
  sharedThreadHydrationCache.prefetch(threadId, options);
}

export function __resetThreadHydrationCacheForTests(): void {
  sharedThreadHydrationCache.clear();
}
