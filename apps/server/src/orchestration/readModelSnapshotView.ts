import type {
  OrchestrationGetSnapshotInput,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@ace/contracts";
import { updateSnapshotViewCacheStats } from "../runtimeProfile";

const MAX_CACHED_SNAPSHOT_VIEWS = Math.max(
  4,
  Number.parseInt(process.env.ACE_SNAPSHOT_VIEW_CACHE_MAX_ENTRIES ?? "8", 10) || 8,
);
const INITIAL_SNAPSHOT_ACTIVITY_LIMIT_PER_THREAD = 32;

function shouldHydrateAllThreadHistory(input?: OrchestrationGetSnapshotInput): boolean {
  return input === undefined || !Object.prototype.hasOwnProperty.call(input, "hydrateThreadId");
}

function createSummaryThread(thread: OrchestrationThread): OrchestrationThread {
  const latestUserMessage = thread.messages.filter((message) => message.role === "user").at(-1);
  const summaryMessages = latestUserMessage ? [latestUserMessage] : [];
  const summaryActivities =
    thread.activities.length > INITIAL_SNAPSHOT_ACTIVITY_LIMIT_PER_THREAD
      ? thread.activities.slice(-INITIAL_SNAPSHOT_ACTIVITY_LIMIT_PER_THREAD)
      : thread.activities;

  const messagesChanged = summaryMessages.length !== thread.messages.length;
  const activitiesChanged = summaryActivities.length !== thread.activities.length;
  const checkpointsChanged = thread.checkpoints.length > 0;
  const proposedPlansChanged = thread.proposedPlans.length > 0;

  if (!messagesChanged && !activitiesChanged && !checkpointsChanged && !proposedPlansChanged) {
    return thread;
  }

  return {
    ...thread,
    messages: messagesChanged ? summaryMessages : thread.messages,
    activities: activitiesChanged ? summaryActivities : thread.activities,
    proposedPlans: proposedPlansChanged ? [] : thread.proposedPlans,
    checkpoints: checkpointsChanged ? [] : thread.checkpoints,
  };
}

function snapshotViewCacheKey(input?: OrchestrationGetSnapshotInput): string {
  if (shouldHydrateAllThreadHistory(input)) {
    return "full";
  }
  const hydrateThreadId = input?.hydrateThreadId ?? null;
  if (hydrateThreadId === null) {
    return "lean";
  }
  return `thread:${hydrateThreadId}`;
}

function evictOldestCacheEntry(cache: Map<string, OrchestrationReadModel>): void {
  const oldestKey = cache.keys().next().value;
  if (oldestKey !== undefined) {
    cache.delete(oldestKey);
  }
}

function promoteCacheEntry(
  cache: Map<string, OrchestrationReadModel>,
  key: string,
  value: OrchestrationReadModel,
): OrchestrationReadModel {
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function createReadModelSnapshotView(
  readModel: OrchestrationReadModel,
  input?: OrchestrationGetSnapshotInput,
): OrchestrationReadModel {
  if (shouldHydrateAllThreadHistory(input)) {
    return readModel;
  }

  const hydrateThreadId = input?.hydrateThreadId ?? null;
  let changed = false;

  const threads = readModel.threads.map((thread) => {
    if (hydrateThreadId !== null && thread.id === hydrateThreadId) {
      return thread;
    }
    const summaryThread = createSummaryThread(thread);
    if (summaryThread !== thread) {
      changed = true;
    }
    return summaryThread;
  });

  if (!changed) {
    return readModel;
  }

  return {
    ...readModel,
    threads,
  };
}

export interface ReadModelSnapshotViewCache {
  readonly getSnapshot: (
    readModel: OrchestrationReadModel,
    input?: OrchestrationGetSnapshotInput,
  ) => OrchestrationReadModel;
  readonly clear: () => void;
}

export function createReadModelSnapshotViewCache(
  maxEntries = MAX_CACHED_SNAPSHOT_VIEWS,
): ReadModelSnapshotViewCache {
  let cachedSnapshotSequence = -1;
  const cache = new Map<string, OrchestrationReadModel>();
  updateSnapshotViewCacheStats({
    maxEntries: Math.max(1, maxEntries),
    currentEntries: 0,
  });

  return {
    getSnapshot: (readModel, input) => {
      if (cachedSnapshotSequence !== readModel.snapshotSequence) {
        cache.clear();
        cachedSnapshotSequence = readModel.snapshotSequence;
        updateSnapshotViewCacheStats({ currentEntries: cache.size });
      }

      const key = snapshotViewCacheKey(input);
      const cached = cache.get(key);
      if (cached) {
        return promoteCacheEntry(cache, key, cached);
      }

      const snapshotView = createReadModelSnapshotView(readModel, input);
      if (cache.size >= Math.max(1, maxEntries)) {
        evictOldestCacheEntry(cache);
      }
      cache.set(key, snapshotView);
      updateSnapshotViewCacheStats({ currentEntries: cache.size });
      return snapshotView;
    },
    clear: () => {
      cache.clear();
      cachedSnapshotSequence = -1;
      updateSnapshotViewCacheStats({ currentEntries: 0 });
    },
  };
}
