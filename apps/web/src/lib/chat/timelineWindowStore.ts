import {
  type OrchestrationGetThreadTimelineManifestInput,
  type OrchestrationGetThreadTimelineManifestResult,
  type OrchestrationGetThreadTimelinePageInput,
  type OrchestrationGetThreadTimelinePageRangeInput,
  type OrchestrationGetThreadTimelinePageResult,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
  type OrchestrationThreadTimelineEntryReference,
  type ThreadId,
} from "@ace/contracts";
import { create } from "zustand";

import { ensureNativeApi } from "../../nativeApi";
import { LRUCache } from "../lruCache";
import {
  clampCacheBudgetBytes,
  clampCacheEntryCount,
  shouldAvoidSpeculativeWork,
} from "../resourceProfile";
import {
  readPersistedThreadTimelineCache,
  readPersistedThreadTimelinePages,
  writePersistedThreadTimelineCache,
  writePersistedThreadTimelinePage,
} from "./threadTimelineStorage";

const DEFAULT_TIMELINE_PAGE_SIZE = 100;
const INITIAL_TIMELINE_PAGE_SIZE = 50;
const TIMELINE_OPEN_BACKGROUND_BATCH_SIZES = [100, 250, 500] as const;
const TIMELINE_OPEN_CONTINUOUS_BATCH_SIZES = [100, 150, 250, 500] as const;
const TIMELINE_OPEN_CONTINUOUS_DELAY_MS = 32;
const TIMELINE_OPEN_PREFETCH_MAX_PARALLEL_REQUESTS = 2;
const TIMELINE_PROGRESSIVE_BATCH_CHUNK_SIZE = 1;
const TIMELINE_PROGRESSIVE_MAX_CONCURRENT_CHUNKS = 2;
export const TIMELINE_PAGE_RPC_BATCH_LIMIT = 8;
export const TIMELINE_PAGE_CLIENT_BATCH_LIMIT = 2;
const TIMELINE_CACHE_BATCH_SIZE = Math.min(
  TIMELINE_PAGE_RPC_BATCH_LIMIT,
  TIMELINE_PAGE_CLIENT_BATCH_LIMIT,
);
const TIMELINE_CACHE_PERSIST_WRITE_DEBOUNCE_MS = 250;
const TIMELINE_SCROLL_PREFETCH_MAX_ENTRIES = 12_000;
export const TIMELINE_PAGE_FETCH_TIMEOUT_MS = 8_000;
export const TIMELINE_PAGE_FETCH_RETRY_BASE_DELAY_MS = 180;
const TIMELINE_PAGE_FETCH_MAX_RETRIES = 2;
export const TIMELINE_FETCH_STATE_STALE_MS =
  TIMELINE_PAGE_FETCH_TIMEOUT_MS * (TIMELINE_PAGE_FETCH_MAX_RETRIES + 1) +
  TIMELINE_PAGE_FETCH_RETRY_BASE_DELAY_MS * 4 +
  2_000;
const MAX_DYNAMIC_TIMELINE_PAGE_SIZE = 500;
const MAX_TIMELINE_PAGE_CACHE_ENTRIES = clampCacheEntryCount(16_000, {
  moderateCapEntries: 8_000,
  constrainedCapEntries: 500,
});
const MAX_TIMELINE_PAGE_CACHE_MEMORY_BYTES = clampCacheBudgetBytes(256 * 1024 * 1024, {
  moderateCapBytes: 128 * 1024 * 1024,
  constrainedCapBytes: 48 * 1024 * 1024,
});
const MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES = clampCacheEntryCount(24_000, {
  moderateCapEntries: 12_000,
  constrainedCapEntries: 6_000,
});

export interface TimelineManifest {
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly totalItems: number;
  readonly tailStartIndex: number;
  readonly source: "metadata" | "hydrated" | "page";
}

export interface TimelineLoadedRange {
  readonly cacheKey: string;
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly updatedAt: string;
}

export interface TimelineActiveWindow {
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly overscanStartIndex: number;
  readonly overscanEndIndexExclusive: number;
  readonly updatedAt: string | null;
}

export interface TimelinePrefetchRequest {
  readonly startIndex: number;
  readonly limit: number;
  readonly priority: "background" | "immediate";
}

export interface TimelineFetchState {
  readonly inFlightCount: number;
  readonly lastSettledAt: number | null;
  readonly startedAt: number | null;
}

interface TimelineWindowState {
  readonly manifestsByThreadId: Record<string, TimelineManifest>;
  readonly loadedRangesByThreadId: Record<string, readonly TimelineLoadedRange[]>;
  readonly activeWindowByThreadId: Record<string, TimelineActiveWindow>;
  readonly fetchStateByThreadId: Record<string, TimelineFetchState>;
  readonly prefetchQueueByThreadId: Record<string, readonly TimelinePrefetchRequest[]>;
  readonly pageCacheRevision: number;
  readonly rowHeightRevision: number;
  readonly beginPageFetches: (threadId: ThreadId, count: number) => void;
  readonly expireStalePageFetches: (threadId: ThreadId, now: number) => void;
  readonly finishPageFetches: (threadId: ThreadId, count: number) => void;
  readonly primeManifest: (manifest: TimelineManifest) => void;
  readonly primePage: (page: OrchestrationGetThreadTimelinePageResult) => void;
  readonly primePages: (pages: readonly OrchestrationGetThreadTimelinePageResult[]) => void;
  readonly setActiveWindow: (threadId: ThreadId, window: TimelineActiveWindow) => void;
  readonly enqueuePrefetch: (threadId: ThreadId, request: TimelinePrefetchRequest) => void;
  readonly noteRowHeightWrite: () => void;
  readonly clearThread: (threadId: ThreadId) => void;
  readonly reset: () => void;
}

const timelinePageCache = new LRUCache<OrchestrationGetThreadTimelinePageResult>(
  MAX_TIMELINE_PAGE_CACHE_ENTRIES,
  MAX_TIMELINE_PAGE_CACHE_MEMORY_BYTES,
);
const rowHeightCache = new LRUCache<number>(
  MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES,
  MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES * 24,
);
const inFlightPageByKey = new Map<string, Promise<OrchestrationGetThreadTimelinePageResult>>();
const timelineCacheWriteDebounceByThreadId = new Map<ThreadId, ReturnType<typeof setTimeout>>();
const timelineCacheHydrationPromiseByThreadId = new Map<string, Promise<void>>();

function toPersistedTimelineRange(range: TimelineLoadedRange) {
  return {
    startIndex: range.startIndex,
    endIndexExclusive: range.endIndexExclusive,
    cacheKey: range.cacheKey,
    updatedAt: range.updatedAt,
  };
}

function normalizeThreadId(value: string | null | undefined): ThreadId | null {
  return typeof value === "string" ? (value as ThreadId) : null;
}

function schedulePersistedThreadTimelineCacheWrite(threadId: ThreadId): void {
  const previousTimeout = timelineCacheWriteDebounceByThreadId.get(threadId);
  if (previousTimeout !== undefined) {
    clearTimeout(previousTimeout);
  }
  const timeoutId = globalThis.setTimeout(() => {
    void persistThreadTimelineCacheFromState(threadId);
  }, TIMELINE_CACHE_PERSIST_WRITE_DEBOUNCE_MS);
  timelineCacheWriteDebounceByThreadId.set(threadId, timeoutId);
}

async function persistThreadTimelineCacheFromState(threadId: ThreadId): Promise<void> {
  const state = useTimelineWindowStore.getState();
  const manifest = state.manifestsByThreadId[threadId];
  const ranges = state.loadedRangesByThreadId[threadId] ?? [];
  if (!manifest || ranges.length === 0) {
    return;
  }
  await writePersistedThreadTimelineCache({
    threadId,
    manifest: {
      ...manifest,
    },
    ranges: ranges
      .toSorted((left, right) => left.startIndex - right.startIndex)
      .map(toPersistedTimelineRange),
    lastPersistedAt: Date.now(),
  });
}

interface ThreadTimelineOpenPrefetchJob {
  readonly tokens: Set<symbol>;
  done: Promise<void>;
  canceled: boolean;
}

export interface ThreadTimelineOpenPrefetchHandle {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

const openPrefetchJobsByThreadId = new Map<string, ThreadTimelineOpenPrefetchJob>();

export type TimelinePrefetchDirection = "older" | "newer" | "both";

interface PrimeLiveThreadTimelineEntryInput {
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly entry: Omit<OrchestrationThreadTimelineEntryReference, "index">;
  readonly message?: OrchestrationMessage;
  readonly activity?: OrchestrationThreadActivity;
  readonly proposedPlan?: OrchestrationProposedPlan;
}

function estimateTimelinePageSize(page: OrchestrationGetThreadTimelinePageResult): number {
  let size = 768 + page.entries.length * 96;
  for (const message of page.messages) {
    size += 256 + message.text.length * 2 + (message.attachments?.length ?? 0) * 256;
  }
  for (const activity of page.activities) {
    size += 192 + activity.summary.length * 2;
    const payload = activity.payload;
    if (typeof payload === "string") {
      size += Math.min(payload.length, 16_384) * 2;
    }
  }
  for (const plan of page.proposedPlans) {
    size += 192 + Math.min(plan.planMarkdown.length, 24_576) * 2;
  }
  return Math.max(4_096, size);
}

function buildTimelinePageCacheKey(input: {
  readonly threadId: ThreadId;
  readonly updatedAt?: string | null;
  readonly startIndex: number;
  readonly limit: number;
  readonly anchor?: OrchestrationGetThreadTimelinePageInput["anchor"];
}): string {
  return [
    input.threadId,
    input.updatedAt ?? "latest",
    input.anchor ?? "index",
    String(Math.max(0, Math.trunc(input.startIndex))),
    String(Math.max(1, Math.trunc(input.limit))),
  ].join(":");
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTimelinePageFetchTimeoutError(input: {
  readonly attempt: number;
  readonly operationName: string;
}): Error {
  return new Error(
    `${input.operationName} timed out after ${String(TIMELINE_PAGE_FETCH_TIMEOUT_MS)}ms ` +
      `(attempt ${String(input.attempt + 1)} of ${String(TIMELINE_PAGE_FETCH_MAX_RETRIES + 1)}).`,
  );
}

async function runTimelinePageFetchAttempt<T>(
  operationName: string,
  attempt: number,
  operation: () => Promise<T>,
): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let didTimeout = false;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      didTimeout = true;
      reject(createTimelinePageFetchTimeoutError({ operationName, attempt }));
    }, TIMELINE_PAGE_FETCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
    if (didTimeout) {
      operationPromise.catch(() => undefined);
    }
  }
}

function waitForTimelinePageFetchRetryDelay(attempt: number): Promise<void> {
  const delayMs = TIMELINE_PAGE_FETCH_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function resolveEffectiveTimelineOlderPageCount(input: {
  readonly pageSize: number;
  readonly requestedOlderPageCount: number;
}): number {
  const requestedOlderPageCount = Math.max(
    1,
    Math.trunc(Number.isFinite(input.requestedOlderPageCount) ? input.requestedOlderPageCount : 1),
  );
  const maxPageCountByEntryBudget = Math.max(
    1,
    Math.floor(TIMELINE_SCROLL_PREFETCH_MAX_ENTRIES / Math.max(1, input.pageSize)),
  );
  return Math.min(
    requestedOlderPageCount,
    TIMELINE_PAGE_CLIENT_BATCH_LIMIT,
    maxPageCountByEntryBudget,
  );
}

function yieldToTimelineFetchMainThread(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

async function primeFetchedTimelinePages(
  pages: readonly OrchestrationGetThreadTimelinePageResult[],
): Promise<void> {
  if (pages.length === 0) {
    return;
  }
  for (
    let startIndex = 0;
    startIndex < pages.length;
    startIndex += TIMELINE_PAGE_CLIENT_BATCH_LIMIT
  ) {
    const chunk = pages.slice(startIndex, startIndex + TIMELINE_PAGE_CLIENT_BATCH_LIMIT);
    useTimelineWindowStore.getState().primePages(chunk);
    if (startIndex + TIMELINE_PAGE_CLIENT_BATCH_LIMIT < pages.length) {
      await yieldToTimelineFetchMainThread();
    }
  }
}

async function runTimelinePageFetchWithRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TIMELINE_PAGE_FETCH_MAX_RETRIES; attempt += 1) {
    try {
      return await runTimelinePageFetchAttempt(operationName, attempt, operation);
    } catch (error) {
      lastError = error;
      if (attempt >= TIMELINE_PAGE_FETCH_MAX_RETRIES) {
        throw error;
      }
      await waitForTimelinePageFetchRetryDelay(attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timeline page fetch failed.");
}

export function resolveTimelineScrollPrefetchPageSize(velocityPxPerMs: number): number {
  const velocity = Math.max(0, Number.isFinite(velocityPxPerMs) ? velocityPxPerMs : 0);
  let requestedPageSize: number;
  if (velocity < 0.75) requestedPageSize = 100;
  else if (velocity < 1.5) requestedPageSize = 250;
  else if (velocity < 3) requestedPageSize = 500;
  else if (velocity < 6) requestedPageSize = 1_000;
  else if (velocity < 10) requestedPageSize = 2_000;
  else requestedPageSize = MAX_DYNAMIC_TIMELINE_PAGE_SIZE;
  return normalizeTimelinePageSize(requestedPageSize);
}

function normalizeTimelinePageSize(pageSize: number): number {
  return Math.min(
    MAX_DYNAMIC_TIMELINE_PAGE_SIZE,
    Math.max(1, Math.trunc(Number.isFinite(pageSize) ? pageSize : DEFAULT_TIMELINE_PAGE_SIZE)),
  );
}

function normalizeTimelinePageInput(
  input: OrchestrationGetThreadTimelinePageInput,
): OrchestrationGetThreadTimelinePageInput {
  return {
    ...input,
    limit: normalizeTimelinePageSize(input.limit),
  };
}

function mergeLoadedRange(
  ranges: readonly TimelineLoadedRange[],
  nextRange: TimelineLoadedRange,
): readonly TimelineLoadedRange[] {
  const filtered = ranges.filter(
    (range) =>
      range.startIndex !== nextRange.startIndex ||
      range.endIndexExclusive !== nextRange.endIndexExclusive,
  );
  const sorted = [...filtered, nextRange].toSorted(
    (left, right) => left.startIndex - right.startIndex,
  );
  return sorted;
}

function primeTimelinePagesIntoState(
  state: TimelineWindowState,
  pages: readonly OrchestrationGetThreadTimelinePageResult[],
): TimelineWindowState {
  if (pages.length === 0) {
    return state;
  }

  const manifestsByThreadId = { ...state.manifestsByThreadId };
  const loadedRangesByThreadId = { ...state.loadedRangesByThreadId };
  const touchedThreadIds = new Set<ThreadId>();

  for (const page of pages) {
    const cacheKey = buildTimelinePageCacheKey({
      threadId: page.threadId,
      updatedAt: page.updatedAt,
      startIndex: page.startIndex,
      limit: page.endIndexExclusive - page.startIndex,
    });
    const nextRange: TimelineLoadedRange = {
      cacheKey,
      startIndex: page.startIndex,
      endIndexExclusive: page.endIndexExclusive,
      updatedAt: page.updatedAt,
    };
    const nextRanges = mergeLoadedRange(loadedRangesByThreadId[page.threadId] ?? [], nextRange);
    loadedRangesByThreadId[page.threadId] = nextRanges;
    manifestsByThreadId[page.threadId] = {
      threadId: page.threadId,
      updatedAt: page.updatedAt,
      totalItems: page.totalItems,
      tailStartIndex: Math.max(0, page.totalItems - DEFAULT_TIMELINE_PAGE_SIZE),
      source: "page",
    };
    timelinePageCache.set(cacheKey, page, estimateTimelinePageSize(page));
    void writePersistedThreadTimelinePage(cacheKey, page);
    touchedThreadIds.add(page.threadId);
  }

  for (const touchedThreadId of touchedThreadIds) {
    schedulePersistedThreadTimelineCacheWrite(touchedThreadId);
  }

  return {
    ...state,
    manifestsByThreadId,
    loadedRangesByThreadId,
    pageCacheRevision: state.pageCacheRevision + 1,
  };
}

function createInitialTimelineWindowState(): Pick<
  TimelineWindowState,
  | "activeWindowByThreadId"
  | "fetchStateByThreadId"
  | "loadedRangesByThreadId"
  | "manifestsByThreadId"
  | "pageCacheRevision"
  | "prefetchQueueByThreadId"
  | "rowHeightRevision"
> {
  return {
    manifestsByThreadId: {},
    loadedRangesByThreadId: {},
    activeWindowByThreadId: {},
    fetchStateByThreadId: {},
    prefetchQueueByThreadId: {},
    pageCacheRevision: 0,
    rowHeightRevision: 0,
  };
}

export const useTimelineWindowStore = create<TimelineWindowState>((set) => ({
  ...createInitialTimelineWindowState(),
  beginPageFetches: (threadId, count) =>
    set((state) => {
      const fetchCount = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
      if (fetchCount === 0) {
        return state;
      }
      const previous = state.fetchStateByThreadId[threadId];
      return {
        ...state,
        fetchStateByThreadId: {
          ...state.fetchStateByThreadId,
          [threadId]: {
            inFlightCount: (previous?.inFlightCount ?? 0) + fetchCount,
            lastSettledAt: previous?.lastSettledAt ?? null,
            startedAt: Date.now(),
          },
        },
      };
    }),
  expireStalePageFetches: (threadId, now) =>
    set((state) => {
      const previous = state.fetchStateByThreadId[threadId];
      if (
        !previous ||
        previous.inFlightCount <= 0 ||
        previous.startedAt === null ||
        now - previous.startedAt < TIMELINE_FETCH_STATE_STALE_MS
      ) {
        return state;
      }
      return {
        ...state,
        fetchStateByThreadId: {
          ...state.fetchStateByThreadId,
          [threadId]: {
            inFlightCount: 0,
            lastSettledAt: now,
            startedAt: previous.startedAt,
          },
        },
      };
    }),
  finishPageFetches: (threadId, count) =>
    set((state) => {
      const fetchCount = Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0));
      if (fetchCount === 0) {
        return state;
      }
      const previous = state.fetchStateByThreadId[threadId];
      if (!previous) {
        return state;
      }
      return {
        ...state,
        fetchStateByThreadId: {
          ...state.fetchStateByThreadId,
          [threadId]: {
            inFlightCount: Math.max(0, previous.inFlightCount - fetchCount),
            lastSettledAt: Date.now(),
            startedAt: previous.startedAt,
          },
        },
      };
    }),
  primeManifest: (manifest) =>
    set((state) => {
      const previous = state.manifestsByThreadId[manifest.threadId];
      if (
        previous &&
        previous.updatedAt === manifest.updatedAt &&
        previous.totalItems === manifest.totalItems &&
        previous.tailStartIndex === manifest.tailStartIndex &&
        previous.source === manifest.source
      ) {
        return state;
      }
      return {
        ...state,
        manifestsByThreadId: {
          ...state.manifestsByThreadId,
          [manifest.threadId]: manifest,
        },
      };
    }),
  primePage: (page) => set((state) => primeTimelinePagesIntoState(state, [page])),
  primePages: (pages) => set((state) => primeTimelinePagesIntoState(state, pages)),
  setActiveWindow: (threadId, activeWindow) =>
    set((state) => {
      const previous = state.activeWindowByThreadId[threadId];
      if (
        previous &&
        previous.startIndex === activeWindow.startIndex &&
        previous.endIndexExclusive === activeWindow.endIndexExclusive &&
        previous.overscanStartIndex === activeWindow.overscanStartIndex &&
        previous.overscanEndIndexExclusive === activeWindow.overscanEndIndexExclusive &&
        previous.updatedAt === activeWindow.updatedAt
      ) {
        return state;
      }
      return {
        ...state,
        activeWindowByThreadId: {
          ...state.activeWindowByThreadId,
          [threadId]: activeWindow,
        },
      };
    }),
  enqueuePrefetch: (threadId, request) =>
    set((state) => {
      const current = state.prefetchQueueByThreadId[threadId] ?? [];
      if (
        current.some(
          (entry) => entry.startIndex === request.startIndex && entry.limit === request.limit,
        )
      ) {
        return state;
      }
      return {
        ...state,
        prefetchQueueByThreadId: {
          ...state.prefetchQueueByThreadId,
          [threadId]: [...current.slice(-7), request],
        },
      };
    }),
  noteRowHeightWrite: () =>
    set((state) => ({
      ...state,
      rowHeightRevision: state.rowHeightRevision + 1,
    })),
  clearThread: (threadId) =>
    set((state) => {
      const manifestsByThreadId = { ...state.manifestsByThreadId };
      const loadedRangesByThreadId = { ...state.loadedRangesByThreadId };
      const activeWindowByThreadId = { ...state.activeWindowByThreadId };
      const fetchStateByThreadId = { ...state.fetchStateByThreadId };
      const prefetchQueueByThreadId = { ...state.prefetchQueueByThreadId };
      delete manifestsByThreadId[threadId];
      delete loadedRangesByThreadId[threadId];
      delete activeWindowByThreadId[threadId];
      delete fetchStateByThreadId[threadId];
      delete prefetchQueueByThreadId[threadId];
      return {
        ...state,
        manifestsByThreadId,
        loadedRangesByThreadId,
        activeWindowByThreadId,
        fetchStateByThreadId,
        prefetchQueueByThreadId,
      };
    }),
  reset: () => {
    for (const timeoutId of timelineCacheWriteDebounceByThreadId.values()) {
      clearTimeout(timeoutId);
    }
    timelineCacheWriteDebounceByThreadId.clear();
    timelineCacheHydrationPromiseByThreadId.clear();
    for (const job of openPrefetchJobsByThreadId.values()) {
      job.canceled = true;
      job.tokens.clear();
    }
    openPrefetchJobsByThreadId.clear();
    timelinePageCache.clear();
    rowHeightCache.clear();
    inFlightPageByKey.clear();
    set(() => createInitialTimelineWindowState());
  },
}));

export function readCachedThreadTimelinePage(input: {
  readonly threadId: ThreadId;
  readonly updatedAt?: string | null;
  readonly startIndex: number;
  readonly limit: number;
  readonly anchor?: OrchestrationGetThreadTimelinePageInput["anchor"];
}): OrchestrationGetThreadTimelinePageResult | null {
  const direct = timelinePageCache.get(buildTimelinePageCacheKey(input));
  if (direct) {
    return direct;
  }
  if (input.updatedAt !== undefined && input.updatedAt !== null) {
    return null;
  }
  const manifest = useTimelineWindowStore.getState().manifestsByThreadId[input.threadId];
  const startIndex =
    input.anchor === "tail" && manifest
      ? Math.max(0, manifest.totalItems - input.limit)
      : input.startIndex;
  const endIndexExclusive =
    input.anchor === "tail" && manifest
      ? Math.min(manifest.totalItems, startIndex + input.limit)
      : startIndex + input.limit;
  const range = useTimelineWindowStore
    .getState()
    .loadedRangesByThreadId[input.threadId]?.find(
      (candidate) =>
        candidate.startIndex === startIndex && candidate.endIndexExclusive === endIndexExclusive,
    );
  return range ? timelinePageCache.get(range.cacheKey) : null;
}

function shouldApplyPersistedManifest(input: {
  readonly persistedUpdatedAt: string;
  readonly stateManifest: TimelineManifest | undefined;
}): boolean {
  if (!input.stateManifest) {
    return true;
  }
  if (input.stateManifest.source !== "page") {
    return true;
  }
  return input.persistedUpdatedAt > input.stateManifest.updatedAt;
}

export async function hydrateThreadTimelineCacheFromStorage(threadId: ThreadId): Promise<void> {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) {
    return;
  }
  const existing = timelineCacheHydrationPromiseByThreadId.get(normalizedThreadId);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const persisted = await readPersistedThreadTimelineCache(normalizedThreadId);
    if (!persisted) {
      return;
    }

    const state = useTimelineWindowStore.getState();
    const stateManifest = state.manifestsByThreadId[normalizedThreadId];
    const canApplyPersistedManifest = shouldApplyPersistedManifest({
      persistedUpdatedAt: persisted.manifest.updatedAt,
      stateManifest,
    });

    if (
      !canApplyPersistedManifest &&
      (state.loadedRangesByThreadId[normalizedThreadId] ?? []).length > 0
    ) {
      return;
    }

    const ranges = persisted.ranges.toSorted((left, right) => left.startIndex - right.startIndex);
    const persistedPages = await readPersistedThreadTimelinePages(
      ranges.map((range) => range.cacheKey),
    );
    const pages = ranges
      .map((range) => persistedPages.get(range.cacheKey))
      .filter((page): page is OrchestrationGetThreadTimelinePageResult => page !== undefined);

    if (canApplyPersistedManifest) {
      state.primeManifest({
        ...persisted.manifest,
        source: "page",
      });
    }

    if (pages.length > 0) {
      state.primePages(pages);
    }
  })();

  timelineCacheHydrationPromiseByThreadId.set(normalizedThreadId, promise);
  try {
    await promise;
  } finally {
    timelineCacheHydrationPromiseByThreadId.delete(normalizedThreadId);
  }
}

export function readLoadedThreadTimelinePages(
  threadId: ThreadId,
): ReadonlyArray<OrchestrationGetThreadTimelinePageResult> {
  const state = useTimelineWindowStore.getState();
  return (state.loadedRangesByThreadId[threadId] ?? [])
    .toSorted((left, right) => left.startIndex - right.startIndex)
    .flatMap((range) => {
      const page = timelinePageCache.get(range.cacheKey);
      return page ? [page] : [];
    });
}

function readLoadedThreadTimelineEntryIndexes(threadId: ThreadId): Map<string, number> {
  const indexes = new Map<string, number>();
  for (const page of readLoadedThreadTimelinePages(threadId)) {
    for (const entry of page.entries) {
      indexes.set(`${entry.kind}:${entry.id}`, entry.index);
    }
  }
  return indexes;
}

export function writeTimelineRowHeight(cacheKey: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) {
    return;
  }
  rowHeightCache.set(cacheKey, height, 24);
  useTimelineWindowStore.getState().noteRowHeightWrite();
}

export function readTimelineRowHeight(cacheKey: string): number | null {
  return rowHeightCache.get(cacheKey);
}

export function primeThreadTimelineManifestFromReadModelThread(
  thread: OrchestrationReadModel["threads"][number],
  source: TimelineManifest["source"] = "hydrated",
): void {
  const totalItems =
    thread.messages.length + thread.activities.length + thread.proposedPlans.length;
  useTimelineWindowStore.getState().primeManifest({
    threadId: thread.id,
    updatedAt: thread.updatedAt,
    totalItems,
    tailStartIndex: Math.max(0, totalItems - DEFAULT_TIMELINE_PAGE_SIZE),
    source,
  });
}

export async function fetchThreadTimelineManifest(
  input: OrchestrationGetThreadTimelineManifestInput,
): Promise<OrchestrationGetThreadTimelineManifestResult> {
  const current = useTimelineWindowStore.getState().manifestsByThreadId[input.threadId];
  if (current?.source === "page" || current?.source === "hydrated") {
    return {
      threadId: current.threadId,
      updatedAt: current.updatedAt,
      totalItems: current.totalItems,
      tailStartIndex: current.tailStartIndex,
    };
  }
  const manifest = await runTimelinePageFetchWithRetry("getThreadTimelineManifest", () =>
    ensureNativeApi().orchestration.getThreadTimelineManifest(input),
  );
  useTimelineWindowStore.getState().primeManifest({
    ...manifest,
    source: "page",
  });
  return manifest;
}

export async function fetchThreadTimelinePage(
  rawInput: OrchestrationGetThreadTimelinePageInput,
): Promise<OrchestrationGetThreadTimelinePageResult> {
  const input = normalizeTimelinePageInput(rawInput);
  const cached = readCachedThreadTimelinePage(input);
  if (cached) {
    return cached;
  }

  const cacheKey = buildTimelinePageCacheKey(input);
  const existing = inFlightPageByKey.get(cacheKey);
  if (existing) {
    return existing;
  }

  useTimelineWindowStore.getState().beginPageFetches(input.threadId, 1);
  let request: Promise<OrchestrationGetThreadTimelinePageResult>;
  try {
    request = runTimelinePageFetchWithRetry("getThreadTimelinePage", () =>
      ensureNativeApi().orchestration.getThreadTimelinePage(input),
    )
      .then(async (page) => {
        await primeFetchedTimelinePages([page]);
        return page;
      })
      .finally(() => {
        useTimelineWindowStore.getState().finishPageFetches(input.threadId, 1);
        if (inFlightPageByKey.get(cacheKey) === request) {
          inFlightPageByKey.delete(cacheKey);
        }
      });
  } catch (error) {
    useTimelineWindowStore.getState().finishPageFetches(input.threadId, 1);
    throw error;
  }
  inFlightPageByKey.set(cacheKey, request);
  return request;
}

export async function fetchThreadTimelinePages(
  rawInputs: readonly OrchestrationGetThreadTimelinePageInput[],
): Promise<ReadonlyArray<OrchestrationGetThreadTimelinePageResult>> {
  const inputs = rawInputs.map(normalizeTimelinePageInput);
  if (inputs.length === 0) {
    return [];
  }
  if (inputs.length > TIMELINE_CACHE_BATCH_SIZE) {
    const results: OrchestrationGetThreadTimelinePageResult[] = [];
    results.length = inputs.length;
    for (let startIndex = 0; startIndex < inputs.length; startIndex += TIMELINE_CACHE_BATCH_SIZE) {
      const chunk = inputs.slice(startIndex, startIndex + TIMELINE_CACHE_BATCH_SIZE);
      const pages = await fetchThreadTimelinePages(chunk);
      for (const [pageIndex, page] of pages.entries()) {
        results[startIndex + pageIndex] = page;
      }
      if (startIndex + TIMELINE_PAGE_CLIENT_BATCH_LIMIT < inputs.length) {
        await yieldToTimelineFetchMainThread();
      }
    }
    return results;
  }
  if (inputs.length === 1) {
    return [await fetchThreadTimelinePage(inputs[0]!)];
  }

  const results: OrchestrationGetThreadTimelinePageResult[] = [];
  results.length = inputs.length;
  const pendingReads: Promise<void>[] = [];
  const batchEntriesByThreadId = new Map<
    string,
    Array<{
      readonly input: OrchestrationGetThreadTimelinePageInput;
      readonly cacheKey: string;
      readonly resultIndex: number;
      readonly resolve: (page: OrchestrationGetThreadTimelinePageResult) => void;
      readonly reject: (reason?: unknown) => void;
      readonly promise: Promise<OrchestrationGetThreadTimelinePageResult>;
    }>
  >();

  for (const [resultIndex, input] of inputs.entries()) {
    const cached = readCachedThreadTimelinePage(input);
    if (cached) {
      results[resultIndex] = cached;
      continue;
    }

    const cacheKey = buildTimelinePageCacheKey(input);
    const existing = inFlightPageByKey.get(cacheKey);
    if (existing) {
      pendingReads.push(
        existing.then((page) => {
          results[resultIndex] = page;
        }),
      );
      continue;
    }

    const deferred = createDeferred<OrchestrationGetThreadTimelinePageResult>();
    inFlightPageByKey.set(cacheKey, deferred.promise);
    pendingReads.push(
      deferred.promise.then((page) => {
        results[resultIndex] = page;
      }),
    );
    const threadEntries = batchEntriesByThreadId.get(input.threadId) ?? [];
    threadEntries.push({
      input,
      cacheKey,
      resultIndex,
      resolve: deferred.resolve,
      reject: deferred.reject,
      promise: deferred.promise,
    });
    batchEntriesByThreadId.set(input.threadId, threadEntries);
  }

  const batchReads = [...batchEntriesByThreadId.values()].map(async (entries) => {
    const threadId = entries[0]!.input.threadId;
    useTimelineWindowStore.getState().beginPageFetches(threadId, entries.length);
    try {
      const pages = await runTimelinePageFetchWithRetry("getThreadTimelinePages", () =>
        ensureNativeApi().orchestration.getThreadTimelinePages({
          threadId,
          pages: entries.map(
            (entry): OrchestrationGetThreadTimelinePageRangeInput => ({
              startIndex: entry.input.startIndex,
              limit: entry.input.limit,
              ...(entry.input.anchor !== undefined ? { anchor: entry.input.anchor } : {}),
            }),
          ),
        }),
      );
      if (pages.length !== entries.length) {
        throw new Error(
          `Timeline batch returned ${pages.length} pages for ${entries.length} requests.`,
        );
      }
      await primeFetchedTimelinePages(pages);
      for (const [entryIndex, entry] of entries.entries()) {
        const page = pages[entryIndex]!;
        entry.resolve(page);
      }
    } catch (error) {
      for (const entry of entries) {
        entry.reject(error);
      }
    } finally {
      useTimelineWindowStore.getState().finishPageFetches(threadId, entries.length);
      for (const entry of entries) {
        if (inFlightPageByKey.get(entry.cacheKey) === entry.promise) {
          inFlightPageByKey.delete(entry.cacheKey);
        }
      }
    }
  });

  await Promise.all([...batchReads, ...pendingReads]);
  return results;
}

async function fetchThreadTimelinePagesProgressively(
  inputs: readonly OrchestrationGetThreadTimelinePageInput[],
  chunkSize = TIMELINE_PROGRESSIVE_BATCH_CHUNK_SIZE,
): Promise<ReadonlyArray<OrchestrationGetThreadTimelinePageResult>> {
  if (inputs.length <= chunkSize) {
    return fetchThreadTimelinePages(inputs);
  }
  const results: OrchestrationGetThreadTimelinePageResult[] = [];
  results.length = inputs.length;
  const normalizedChunkSize = Math.max(1, Math.trunc(chunkSize));
  const chunks: Array<{
    readonly inputs: readonly OrchestrationGetThreadTimelinePageInput[];
    readonly startIndex: number;
  }> = [];
  for (let startIndex = 0; startIndex < inputs.length; startIndex += normalizedChunkSize) {
    chunks.push({
      startIndex,
      inputs: inputs.slice(startIndex, startIndex + normalizedChunkSize),
    });
  }
  for (
    let chunkGroupStart = 0;
    chunkGroupStart < chunks.length;
    chunkGroupStart += TIMELINE_PROGRESSIVE_MAX_CONCURRENT_CHUNKS
  ) {
    const chunkGroup = chunks.slice(
      chunkGroupStart,
      chunkGroupStart + TIMELINE_PROGRESSIVE_MAX_CONCURRENT_CHUNKS,
    );
    await Promise.all(
      chunkGroup.map(async (chunk) => {
        const pages = await fetchThreadTimelinePages(chunk.inputs);
        for (const [pageIndex, page] of pages.entries()) {
          results[chunk.startIndex + pageIndex] = page;
        }
      }),
    );
    if (chunkGroupStart + TIMELINE_PROGRESSIVE_MAX_CONCURRENT_CHUNKS < chunks.length) {
      await yieldToTimelineFetchMainThread();
    }
  }
  return results;
}

export async function ensureThreadTimelineRange(input: {
  readonly threadId: ThreadId;
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly pageSize?: number;
  readonly priority?: "background" | "immediate";
}): Promise<void> {
  const priority = input.priority ?? "background";
  if (priority === "background" && shouldAvoidSpeculativeWork()) {
    return;
  }
  const pageSize = normalizeTimelinePageSize(input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE);
  const startIndex = Math.max(0, Math.trunc(input.startIndex));
  const endIndexExclusive = Math.max(startIndex, Math.trunc(input.endIndexExclusive));
  if (startIndex === endIndexExclusive) {
    return;
  }

  useTimelineWindowStore.getState().enqueuePrefetch(input.threadId, {
    startIndex,
    limit: endIndexExclusive - startIndex,
    priority,
  });
  const requests: OrchestrationGetThreadTimelinePageInput[] = [];
  for (let pageStart = startIndex; pageStart < endIndexExclusive; pageStart += pageSize) {
    requests.push({
      threadId: input.threadId,
      startIndex: pageStart,
      limit: Math.min(pageSize, endIndexExclusive - pageStart),
    });
  }
  await fetchThreadTimelinePages(requests);
}

export async function prefetchThreadTimelineAroundLoadedWindow(input: {
  readonly threadId: ThreadId;
  readonly priority?: "background" | "immediate";
  readonly pageSize?: number;
  readonly olderPageCount?: number;
  readonly direction?: TimelinePrefetchDirection;
}): Promise<void> {
  const priority = input.priority ?? "background";
  if (priority === "background" && shouldAvoidSpeculativeWork()) {
    return;
  }
  const pageSize = normalizeTimelinePageSize(input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE);
  const requestedOlderPageCount = input.olderPageCount ?? 1;
  const olderPageCount = resolveEffectiveTimelineOlderPageCount({
    pageSize,
    requestedOlderPageCount,
  });
  const direction = input.direction ?? "both";
  const state = useTimelineWindowStore.getState();
  const manifest = state.manifestsByThreadId[input.threadId];
  const ranges = state.loadedRangesByThreadId[input.threadId] ?? [];
  if (!manifest || ranges.length === 0) {
    await prefetchThreadTimelineWindows({
      threadId: input.threadId,
      pageSize,
      priority,
    });
    return;
  }

  const sortedRanges = [...ranges].toSorted((left, right) => left.startIndex - right.startIndex);
  const firstRange = sortedRanges[0];
  const lastRange = sortedRanges.at(-1);
  const requests: Promise<void>[] = [];
  if ((direction === "older" || direction === "both") && firstRange && firstRange.startIndex > 0) {
    const previousStartIndex = Math.max(0, firstRange.startIndex - pageSize * olderPageCount);
    requests.push(
      ensureThreadTimelineRange({
        threadId: input.threadId,
        startIndex: previousStartIndex,
        endIndexExclusive: firstRange.startIndex,
        pageSize,
        priority,
      }),
    );
  }
  if (
    (direction === "newer" || direction === "both") &&
    lastRange &&
    lastRange.endIndexExclusive < manifest.totalItems
  ) {
    requests.push(
      ensureThreadTimelineRange({
        threadId: input.threadId,
        startIndex: lastRange.endIndexExclusive,
        endIndexExclusive: Math.min(manifest.totalItems, lastRange.endIndexExclusive + pageSize),
        pageSize,
        priority,
      }),
    );
  }
  await Promise.all(requests);
}

export function primeLiveThreadTimelineEntry(input: PrimeLiveThreadTimelineEntryInput): void {
  const state = useTimelineWindowStore.getState();
  const manifest = state.manifestsByThreadId[input.threadId];
  const loadedIndexes = readLoadedThreadTimelineEntryIndexes(input.threadId);
  const entryKey = `${input.entry.kind}:${input.entry.id}`;
  const existingIndex = loadedIndexes.get(entryKey);
  const nextIndex = existingIndex ?? manifest?.totalItems ?? 0;
  const totalItems = Math.max(manifest?.totalItems ?? 0, nextIndex + 1);
  const page: OrchestrationGetThreadTimelinePageResult = {
    threadId: input.threadId,
    updatedAt: input.updatedAt,
    totalItems,
    startIndex: nextIndex,
    endIndexExclusive: nextIndex + 1,
    hasPrevious: nextIndex > 0,
    hasNext: false,
    entries: [
      {
        ...input.entry,
        index: nextIndex,
      },
    ],
    messages: input.message ? [input.message] : [],
    activities: input.activity ? [input.activity] : [],
    proposedPlans: input.proposedPlan ? [input.proposedPlan] : [],
  };
  state.primePage(page);
}

async function prefetchOlderThreadTimelineBatches(input: {
  readonly threadId: ThreadId;
  readonly fromStartIndex: number;
  readonly batchSizes: readonly number[];
}): Promise<void> {
  let nextEndIndexExclusive = Math.max(0, Math.trunc(input.fromStartIndex));
  const requests: OrchestrationGetThreadTimelinePageInput[] = [];
  for (const rawBatchSize of input.batchSizes) {
    if (shouldAvoidSpeculativeWork()) {
      break;
    }
    const batchSize = normalizeTimelinePageSize(rawBatchSize);
    if (nextEndIndexExclusive <= 0) {
      break;
    }
    const startIndex = Math.max(0, nextEndIndexExclusive - batchSize);
    useTimelineWindowStore.getState().enqueuePrefetch(input.threadId, {
      startIndex,
      limit: nextEndIndexExclusive - startIndex,
      priority: "background",
    });
    requests.push({
      threadId: input.threadId,
      startIndex,
      limit: nextEndIndexExclusive - startIndex,
    });
    nextEndIndexExclusive = startIndex;
  }
  await fetchThreadTimelinePagesProgressively(requests);
}

function waitForOpenTimelinePrefetchDelay(input: {
  readonly delayMs: number;
  readonly isCanceled: () => boolean;
}): Promise<void> {
  if (input.delayMs <= 0 || input.isCanceled()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, input.delayMs);
  });
}

async function prefetchOlderThreadTimelineContinuously(input: {
  readonly threadId: ThreadId;
  readonly fromStartIndex: number;
  readonly batchSizes: readonly number[];
  readonly delayMs: number;
  readonly isCanceled: () => boolean;
}): Promise<void> {
  let nextEndIndexExclusive = Math.max(0, Math.trunc(input.fromStartIndex));
  let batchIndex = 0;
  while (nextEndIndexExclusive > 0) {
    if (input.isCanceled() || shouldAvoidSpeculativeWork()) {
      return;
    }
    const requests: OrchestrationGetThreadTimelinePageInput[] = [];
    for (
      let requestIndex = 0;
      requestIndex < TIMELINE_OPEN_PREFETCH_MAX_PARALLEL_REQUESTS && nextEndIndexExclusive > 0;
      requestIndex += 1
    ) {
      const rawBatchSize =
        input.batchSizes[Math.min(batchIndex, input.batchSizes.length - 1)] ??
        MAX_DYNAMIC_TIMELINE_PAGE_SIZE;
      const batchSize = normalizeTimelinePageSize(rawBatchSize);
      const startIndex = Math.max(0, nextEndIndexExclusive - batchSize);
      useTimelineWindowStore.getState().enqueuePrefetch(input.threadId, {
        startIndex,
        limit: nextEndIndexExclusive - startIndex,
        priority: "background",
      });
      requests.push({
        threadId: input.threadId,
        startIndex,
        limit: nextEndIndexExclusive - startIndex,
      });
      nextEndIndexExclusive = startIndex;
      batchIndex += 1;
    }
    await fetchThreadTimelinePagesProgressively(requests);
    await waitForOpenTimelinePrefetchDelay({
      delayMs: input.delayMs,
      isCanceled: input.isCanceled,
    });
  }
}

export async function prefetchThreadTimelineWindows(input: {
  readonly threadId: ThreadId;
  readonly totalItemsHint?: number | null;
  readonly pageSize?: number;
  readonly priority?: "background" | "immediate";
  readonly backgroundBatchSizes?: readonly number[];
}): Promise<OrchestrationGetThreadTimelinePageResult | null> {
  const priority = input.priority ?? "background";
  if (priority === "background" && shouldAvoidSpeculativeWork()) {
    return null;
  }

  const pageSize = normalizeTimelinePageSize(input.pageSize ?? INITIAL_TIMELINE_PAGE_SIZE);
  const totalItemsHint = input.totalItemsHint ?? null;
  const tailStartIndex =
    typeof totalItemsHint === "number" ? Math.max(0, totalItemsHint - pageSize) : 0;
  const tailPage =
    typeof totalItemsHint === "number"
      ? await fetchThreadTimelinePage({
          threadId: input.threadId,
          startIndex: tailStartIndex,
          limit: pageSize,
        })
      : await fetchThreadTimelinePage({
          threadId: input.threadId,
          startIndex: 0,
          limit: pageSize,
          anchor: "tail",
        });

  const backgroundBatchSizes = input.backgroundBatchSizes ?? TIMELINE_OPEN_BACKGROUND_BATCH_SIZES;
  if (backgroundBatchSizes.length > 0) {
    void prefetchOlderThreadTimelineBatches({
      threadId: input.threadId,
      fromStartIndex: tailPage.startIndex,
      batchSizes: backgroundBatchSizes,
    }).catch(() => undefined);
  }
  return tailPage;
}

export function startThreadTimelineOpenPrefetch(input: {
  readonly threadId: ThreadId;
  readonly totalItemsHint?: number | null;
  readonly pageSize?: number;
  readonly priority?: "background" | "immediate";
  readonly batchSizes?: readonly number[];
  readonly delayMs?: number;
}): ThreadTimelineOpenPrefetchHandle {
  const threadKey = String(input.threadId);
  const existingJob = openPrefetchJobsByThreadId.get(threadKey);
  const token = Symbol(threadKey);
  if (existingJob) {
    existingJob.tokens.add(token);
    return {
      done: existingJob.done,
      stop: () => {
        existingJob.tokens.delete(token);
        if (existingJob.tokens.size === 0) {
          existingJob.canceled = true;
          openPrefetchJobsByThreadId.delete(threadKey);
        }
      },
    };
  }

  const job: ThreadTimelineOpenPrefetchJob = {
    tokens: new Set([token]),
    canceled: false,
    done: Promise.resolve(),
  };
  openPrefetchJobsByThreadId.set(threadKey, job);

  job.done = (async () => {
    const tailPage = await prefetchThreadTimelineWindows({
      threadId: input.threadId,
      ...(input.totalItemsHint !== undefined ? { totalItemsHint: input.totalItemsHint } : {}),
      ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      priority: input.priority ?? "immediate",
      backgroundBatchSizes: [],
    });
    if (!tailPage || job.canceled) {
      return;
    }
    await prefetchOlderThreadTimelineContinuously({
      threadId: input.threadId,
      fromStartIndex: tailPage.startIndex,
      batchSizes: input.batchSizes ?? TIMELINE_OPEN_CONTINUOUS_BATCH_SIZES,
      delayMs: input.delayMs ?? TIMELINE_OPEN_CONTINUOUS_DELAY_MS,
      isCanceled: () => job.canceled,
    });
  })().finally(() => {
    if (openPrefetchJobsByThreadId.get(threadKey) === job) {
      openPrefetchJobsByThreadId.delete(threadKey);
    }
  });

  return {
    done: job.done,
    stop: () => {
      job.tokens.delete(token);
      if (job.tokens.size === 0) {
        job.canceled = true;
        openPrefetchJobsByThreadId.delete(threadKey);
      }
    },
  };
}
