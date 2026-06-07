import {
  type OrchestrationGetThreadTimelinePageInput,
  type OrchestrationGetThreadTimelinePageResult,
  type OrchestrationReadModel,
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

const DEFAULT_TIMELINE_PAGE_SIZE = 128;
const MAX_TIMELINE_PAGE_CACHE_ENTRIES = clampCacheEntryCount(96, {
  moderateCapEntries: 64,
  constrainedCapEntries: 32,
});
const MAX_TIMELINE_PAGE_CACHE_MEMORY_BYTES = clampCacheBudgetBytes(48 * 1024 * 1024, {
  moderateCapBytes: 24 * 1024 * 1024,
  constrainedCapBytes: 12 * 1024 * 1024,
});
const MAX_TIMELINE_ROW_HEIGHT_CACHE_ENTRIES = clampCacheEntryCount(24_000, {
  moderateCapEntries: 12_000,
  constrainedCapEntries: 6_000,
});

export interface TimelineManifest {
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly totalItems: number;
  readonly source: "lean" | "hydrated" | "page";
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

interface TimelineWindowState {
  readonly manifestsByThreadId: Record<string, TimelineManifest>;
  readonly loadedRangesByThreadId: Record<string, readonly TimelineLoadedRange[]>;
  readonly activeWindowByThreadId: Record<string, TimelineActiveWindow>;
  readonly prefetchQueueByThreadId: Record<string, readonly TimelinePrefetchRequest[]>;
  readonly pageCacheRevision: number;
  readonly rowHeightRevision: number;
  readonly primeManifest: (manifest: TimelineManifest) => void;
  readonly primePage: (page: OrchestrationGetThreadTimelinePageResult) => void;
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
}): string {
  return [
    input.threadId,
    input.updatedAt ?? "latest",
    String(Math.max(0, Math.trunc(input.startIndex))),
    String(Math.max(1, Math.trunc(input.limit))),
  ].join(":");
}

function mergeLoadedRange(
  ranges: readonly TimelineLoadedRange[],
  nextRange: TimelineLoadedRange,
): readonly TimelineLoadedRange[] {
  const filtered = ranges.filter(
    (range) =>
      range.updatedAt === nextRange.updatedAt &&
      (range.startIndex !== nextRange.startIndex ||
        range.endIndexExclusive !== nextRange.endIndexExclusive),
  );
  return [...filtered, nextRange].toSorted((left, right) => left.startIndex - right.startIndex);
}

function createInitialTimelineWindowState(): Pick<
  TimelineWindowState,
  | "activeWindowByThreadId"
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
    prefetchQueueByThreadId: {},
    pageCacheRevision: 0,
    rowHeightRevision: 0,
  };
}

export const useTimelineWindowStore = create<TimelineWindowState>((set) => ({
  ...createInitialTimelineWindowState(),
  primeManifest: (manifest) =>
    set((state) => {
      const previous = state.manifestsByThreadId[manifest.threadId];
      if (
        previous &&
        previous.updatedAt === manifest.updatedAt &&
        previous.totalItems === manifest.totalItems &&
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
  primePage: (page) =>
    set((state) => {
      const cacheKey = buildTimelinePageCacheKey({
        threadId: page.threadId,
        updatedAt: page.updatedAt,
        startIndex: page.startIndex,
        limit: page.endIndexExclusive - page.startIndex,
      });
      timelinePageCache.set(cacheKey, page, estimateTimelinePageSize(page));
      const nextRange: TimelineLoadedRange = {
        cacheKey,
        startIndex: page.startIndex,
        endIndexExclusive: page.endIndexExclusive,
        updatedAt: page.updatedAt,
      };
      return {
        ...state,
        manifestsByThreadId: {
          ...state.manifestsByThreadId,
          [page.threadId]: {
            threadId: page.threadId,
            updatedAt: page.updatedAt,
            totalItems: page.totalItems,
            source: "page",
          },
        },
        loadedRangesByThreadId: {
          ...state.loadedRangesByThreadId,
          [page.threadId]: mergeLoadedRange(
            state.loadedRangesByThreadId[page.threadId] ?? [],
            nextRange,
          ),
        },
        pageCacheRevision: state.pageCacheRevision + 1,
      };
    }),
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
      const prefetchQueueByThreadId = { ...state.prefetchQueueByThreadId };
      delete manifestsByThreadId[threadId];
      delete loadedRangesByThreadId[threadId];
      delete activeWindowByThreadId[threadId];
      delete prefetchQueueByThreadId[threadId];
      return {
        ...state,
        manifestsByThreadId,
        loadedRangesByThreadId,
        activeWindowByThreadId,
        prefetchQueueByThreadId,
      };
    }),
  reset: () => {
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
}): OrchestrationGetThreadTimelinePageResult | null {
  const direct = timelinePageCache.get(buildTimelinePageCacheKey(input));
  if (direct) {
    return direct;
  }
  if (input.updatedAt !== undefined && input.updatedAt !== null) {
    return null;
  }
  const endIndexExclusive = input.startIndex + input.limit;
  const range = useTimelineWindowStore
    .getState()
    .loadedRangesByThreadId[input.threadId]?.find(
      (candidate) =>
        candidate.startIndex === input.startIndex &&
        candidate.endIndexExclusive === endIndexExclusive,
    );
  return range ? timelinePageCache.get(range.cacheKey) : null;
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
  useTimelineWindowStore.getState().primeManifest({
    threadId: thread.id,
    updatedAt: thread.updatedAt,
    totalItems: thread.messages.length + thread.activities.length + thread.proposedPlans.length,
    source,
  });
}

export async function fetchThreadTimelinePage(
  input: OrchestrationGetThreadTimelinePageInput,
): Promise<OrchestrationGetThreadTimelinePageResult> {
  const cached = readCachedThreadTimelinePage(input);
  if (cached) {
    return cached;
  }

  const cacheKey = buildTimelinePageCacheKey(input);
  const existing = inFlightPageByKey.get(cacheKey);
  if (existing) {
    return existing;
  }

  const request = ensureNativeApi()
    .orchestration.getThreadTimelinePage(input)
    .then((page) => {
      useTimelineWindowStore.getState().primePage(page);
      return page;
    })
    .finally(() => {
      if (inFlightPageByKey.get(cacheKey) === request) {
        inFlightPageByKey.delete(cacheKey);
      }
    });
  inFlightPageByKey.set(cacheKey, request);
  return request;
}

export async function prefetchThreadTimelineWindows(input: {
  readonly threadId: ThreadId;
  readonly totalItemsHint?: number | null;
  readonly pageSize?: number;
  readonly priority?: "background" | "immediate";
}): Promise<void> {
  const priority = input.priority ?? "background";
  if (priority === "background" && shouldAvoidSpeculativeWork()) {
    return;
  }

  const pageSize = Math.max(1, Math.trunc(input.pageSize ?? DEFAULT_TIMELINE_PAGE_SIZE));
  const starts = new Set<number>([0]);
  if (typeof input.totalItemsHint === "number" && input.totalItemsHint > pageSize) {
    starts.add(Math.max(0, input.totalItemsHint - pageSize));
  }

  useTimelineWindowStore
    .getState()
    .enqueuePrefetch(input.threadId, { startIndex: 0, limit: pageSize, priority });

  const pages = await Promise.all(
    [...starts].map((startIndex) =>
      fetchThreadTimelinePage({
        threadId: input.threadId,
        startIndex,
        limit: pageSize,
      }),
    ),
  );
  const firstPage = pages[0];
  if (firstPage?.hasNext && starts.size === 1) {
    const tailStartIndex = Math.max(0, firstPage.totalItems - pageSize);
    if (tailStartIndex !== firstPage.startIndex) {
      useTimelineWindowStore.getState().enqueuePrefetch(input.threadId, {
        startIndex: tailStartIndex,
        limit: pageSize,
        priority,
      });
      await fetchThreadTimelinePage({
        threadId: input.threadId,
        startIndex: tailStartIndex,
        limit: pageSize,
      });
    }
  }
}
