import {
  type OrchestrationGetThreadTimelineManifestInput,
  type OrchestrationGetThreadTimelineManifestResult,
  type OrchestrationGetThreadTimelinePageInput,
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

const DEFAULT_TIMELINE_PAGE_SIZE = 100;
const INITIAL_TIMELINE_PAGE_SIZE = 50;
const TIMELINE_OPEN_BACKGROUND_BATCH_SIZES = [250, 500, 1_000] as const;
const MAX_LOADED_TIMELINE_RANGES_PER_THREAD = 24;
const MAX_DYNAMIC_TIMELINE_PAGE_SIZE = 4_000;
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
  readonly tailStartIndex: number;
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

export function resolveTimelineScrollPrefetchPageSize(velocityPxPerMs: number): number {
  const velocity = Math.max(0, Number.isFinite(velocityPxPerMs) ? velocityPxPerMs : 0);
  if (velocity < 0.75) return 100;
  if (velocity < 1.5) return 250;
  if (velocity < 3) return 500;
  if (velocity < 6) return 1_000;
  if (velocity < 10) return 2_000;
  return MAX_DYNAMIC_TIMELINE_PAGE_SIZE;
}

function normalizeTimelinePageSize(pageSize: number): number {
  return Math.min(
    MAX_DYNAMIC_TIMELINE_PAGE_SIZE,
    Math.max(1, Math.trunc(Number.isFinite(pageSize) ? pageSize : DEFAULT_TIMELINE_PAGE_SIZE)),
  );
}

function rangeDistanceToAnchor(range: TimelineLoadedRange, anchorIndex: number): number {
  if (anchorIndex >= range.startIndex && anchorIndex < range.endIndexExclusive) {
    return 0;
  }
  return Math.min(
    Math.abs(anchorIndex - range.startIndex),
    Math.abs(anchorIndex - range.endIndexExclusive),
  );
}

function selectRetainedLoadedRanges(input: {
  readonly ranges: readonly TimelineLoadedRange[];
  readonly nextRange: TimelineLoadedRange;
  readonly activeWindow?: TimelineActiveWindow | undefined;
  readonly totalItems: number;
}): readonly TimelineLoadedRange[] {
  if (input.ranges.length <= MAX_LOADED_TIMELINE_RANGES_PER_THREAD) {
    return input.ranges;
  }
  const activeWindow =
    input.activeWindow?.updatedAt === null ||
    input.activeWindow?.updatedAt === input.nextRange.updatedAt
      ? input.activeWindow
      : undefined;
  const anchorIndex = activeWindow
    ? Math.floor((activeWindow.startIndex + activeWindow.endIndexExclusive) / 2)
    : Math.max(0, input.totalItems - 1);
  const nextRangeKey = `${input.nextRange.startIndex}:${input.nextRange.endIndexExclusive}`;
  const retained = input.ranges
    .map((range) => {
      const rangeKey = `${range.startIndex}:${range.endIndexExclusive}`;
      return {
        range,
        score:
          rangeKey === nextRangeKey
            ? -1
            : rangeDistanceToAnchor(range, anchorIndex) +
              (range.endIndexExclusive < anchorIndex ? 0.25 : 0),
      };
    })
    .toSorted(
      (left, right) =>
        left.score - right.score ||
        left.range.startIndex - right.range.startIndex ||
        left.range.endIndexExclusive - right.range.endIndexExclusive,
    )
    .slice(0, MAX_LOADED_TIMELINE_RANGES_PER_THREAD)
    .map((entry) => entry.range)
    .toSorted((left, right) => left.startIndex - right.startIndex);

  return retained;
}

function mergeLoadedRange(
  ranges: readonly TimelineLoadedRange[],
  nextRange: TimelineLoadedRange,
  activeWindow: TimelineActiveWindow | undefined,
  totalItems: number,
): readonly TimelineLoadedRange[] {
  const filtered = ranges.filter(
    (range) =>
      range.startIndex !== nextRange.startIndex ||
      range.endIndexExclusive !== nextRange.endIndexExclusive,
  );
  const sorted = [...filtered, nextRange].toSorted(
    (left, right) => left.startIndex - right.startIndex,
  );
  if (sorted.length <= MAX_LOADED_TIMELINE_RANGES_PER_THREAD) {
    return sorted;
  }
  return selectRetainedLoadedRanges({
    ranges: sorted,
    nextRange,
    activeWindow,
    totalItems,
  });
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
  primePage: (page) =>
    set((state) => {
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
      const nextRanges = mergeLoadedRange(
        state.loadedRangesByThreadId[page.threadId] ?? [],
        nextRange,
        state.activeWindowByThreadId[page.threadId],
        page.totalItems,
      );
      timelinePageCache.set(
        cacheKey,
        page,
        estimateTimelinePageSize(page),
        new Set(nextRanges.map((range) => range.cacheKey)),
      );
      return {
        ...state,
        manifestsByThreadId: {
          ...state.manifestsByThreadId,
          [page.threadId]: {
            threadId: page.threadId,
            updatedAt: page.updatedAt,
            totalItems: page.totalItems,
            tailStartIndex: Math.max(0, page.totalItems - DEFAULT_TIMELINE_PAGE_SIZE),
            source: "page",
          },
        },
        loadedRangesByThreadId: {
          ...state.loadedRangesByThreadId,
          [page.threadId]: nextRanges,
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
  const manifest = await ensureNativeApi().orchestration.getThreadTimelineManifest(input);
  useTimelineWindowStore.getState().primeManifest({
    ...manifest,
    source: "page",
  });
  return manifest;
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
  const requests: Promise<OrchestrationGetThreadTimelinePageResult>[] = [];
  for (let pageStart = startIndex; pageStart < endIndexExclusive; pageStart += pageSize) {
    requests.push(
      fetchThreadTimelinePage({
        threadId: input.threadId,
        startIndex: pageStart,
        limit: Math.min(pageSize, endIndexExclusive - pageStart),
      }),
    );
  }
  await Promise.all(requests);
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
  const olderPageCount = Math.max(
    1,
    Math.trunc(Number.isFinite(requestedOlderPageCount) ? requestedOlderPageCount : 1),
  );
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
  for (const rawBatchSize of input.batchSizes) {
    if (shouldAvoidSpeculativeWork()) {
      return;
    }
    const batchSize = Math.max(1, Math.trunc(rawBatchSize));
    if (nextEndIndexExclusive <= 0) {
      return;
    }
    const startIndex = Math.max(0, nextEndIndexExclusive - batchSize);
    useTimelineWindowStore.getState().enqueuePrefetch(input.threadId, {
      startIndex,
      limit: nextEndIndexExclusive - startIndex,
      priority: "background",
    });
    await fetchThreadTimelinePage({
      threadId: input.threadId,
      startIndex,
      limit: nextEndIndexExclusive - startIndex,
    });
    nextEndIndexExclusive = startIndex;
  }
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

  void prefetchOlderThreadTimelineBatches({
    threadId: input.threadId,
    fromStartIndex: tailPage.startIndex,
    batchSizes: TIMELINE_OPEN_BACKGROUND_BATCH_SIZES,
  }).catch(() => undefined);
}
