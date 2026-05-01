import TimelineRowsWorker from "../../workers/timelineRows.worker?worker";
import { fnv1a32 } from "../diffRendering";
import { LRUCache } from "../lruCache";
import { registerMemoryPressureHandler, shouldBypassNonEssentialCaching } from "../memoryPressure";
import { clampCacheBudgetBytes, clampCacheEntryCount } from "../resourceProfile";
import {
  buildTimelineRows,
  estimateTimelineRowsCacheSize,
  type BuildTimelineRowsInput,
  type TimelineRow,
} from "./timelineRows";

const MAX_TIMELINE_ROWS_CACHE_ENTRIES = clampCacheEntryCount(128, {
  moderateCapEntries: 80,
  constrainedCapEntries: 40,
});
const MAX_TIMELINE_ROWS_CACHE_MEMORY_BYTES = clampCacheBudgetBytes(64 * 1024 * 1024, {
  moderateCapBytes: 32 * 1024 * 1024,
  constrainedCapBytes: 16 * 1024 * 1024,
});

interface TimelineRowsWorkerRequest {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly input: BuildTimelineRowsInput;
}

interface TimelineRowsWorkerSuccess {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly input: BuildTimelineRowsInput;
  readonly rows: ReadonlyArray<TimelineRow>;
}

interface TimelineRowsWorkerFailure {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly error: string;
}

type TimelineRowsWorkerResponse = TimelineRowsWorkerSuccess | TimelineRowsWorkerFailure;

const timelineRowsCache = new LRUCache<ReadonlyArray<TimelineRow>>(
  MAX_TIMELINE_ROWS_CACHE_ENTRIES,
  MAX_TIMELINE_ROWS_CACHE_MEMORY_BYTES,
);
const inflightTimelineRowsByCacheKey = new Map<string, Promise<ReadonlyArray<TimelineRow>>>();
const pendingTimelineRowsByRequestId = new Map<
  number,
  {
    readonly resolve: (rows: ReadonlyArray<TimelineRow>) => void;
    readonly reject: (reason?: unknown) => void;
  }
>();
const timelineEntryTokenByReference = new WeakMap<ReadonlyArray<unknown>, string>();

let nextTimelineRowsRequestId = 1;
let nextTimelineEntryTokenId = 1;
let timelineRowsWorker: Worker | null | undefined;

registerMemoryPressureHandler({
  id: "timeline-rows-cache",
  minLevel: "high",
  release: () => {
    timelineRowsCache.clear();
    inflightTimelineRowsByCacheKey.clear();
    pendingTimelineRowsByRequestId.clear();
    timelineRowsWorker?.terminate();
    timelineRowsWorker = undefined;
  },
});

function getTimelineEntryToken(entries: ReadonlyArray<unknown>): string {
  const cached = timelineEntryTokenByReference.get(entries);
  if (cached) {
    return cached;
  }
  const next = `timeline-${nextTimelineEntryTokenId++}`;
  timelineEntryTokenByReference.set(entries, next);
  return next;
}

function getTimelineRowsWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }
  if (timelineRowsWorker === undefined) {
    const worker = new TimelineRowsWorker();
    worker.addEventListener("message", (event: MessageEvent<TimelineRowsWorkerResponse>) => {
      const response = event.data;
      const pending = pendingTimelineRowsByRequestId.get(response.requestId);
      if (!pending) {
        return;
      }
      pendingTimelineRowsByRequestId.delete(response.requestId);
      if ("error" in response) {
        pending.reject(new Error(response.error));
        return;
      }
      timelineRowsCache.set(
        response.cacheKey,
        response.rows,
        estimateTimelineRowsCacheSize(response.input, response.rows),
      );
      pending.resolve(response.rows);
    });
    worker.addEventListener("error", (event) => {
      for (const pending of pendingTimelineRowsByRequestId.values()) {
        pending.reject(event.error ?? new Error("Timeline rows worker failed."));
      }
      pendingTimelineRowsByRequestId.clear();
      inflightTimelineRowsByCacheKey.clear();
      worker.terminate();
      timelineRowsWorker = undefined;
    });
    timelineRowsWorker = worker;
  }
  return timelineRowsWorker;
}

export function buildTimelineRowsCacheKey(input: BuildTimelineRowsInput): string {
  const summary = input.completionSummary ?? "";
  const summaryHash = summary.length > 0 ? fnv1a32(summary).toString(36) : "0";
  return [
    "timeline-rows:v1",
    getTimelineEntryToken(input.timelineEntries),
    input.activeTurnInProgress ? "1" : "0",
    input.activeTurnStartedAt ?? "none",
    input.completionDividerBeforeEntryId ?? "none",
    summary.length,
    summaryHash,
    input.isWorking ? "1" : "0",
  ].join(":");
}

export function readCachedTimelineRows(cacheKey: string): ReadonlyArray<TimelineRow> | null {
  return timelineRowsCache.get(cacheKey);
}

export function writeCachedTimelineRows(
  cacheKey: string,
  input: BuildTimelineRowsInput,
  rows: ReadonlyArray<TimelineRow>,
): ReadonlyArray<TimelineRow> {
  if (!shouldBypassNonEssentialCaching()) {
    timelineRowsCache.set(cacheKey, rows, estimateTimelineRowsCacheSize(input, rows));
  }
  return rows;
}

export function requestTimelineRows(
  cacheKey: string,
  input: BuildTimelineRowsInput,
): Promise<ReadonlyArray<TimelineRow>> {
  const cached = readCachedTimelineRows(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }

  const inflight = inflightTimelineRowsByCacheKey.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const worker = getTimelineRowsWorker();
  if (!worker || shouldBypassNonEssentialCaching()) {
    const rows = buildTimelineRows(input);
    writeCachedTimelineRows(cacheKey, input, rows);
    return Promise.resolve(rows);
  }

  const requestId = nextTimelineRowsRequestId++;
  const promise = new Promise<ReadonlyArray<TimelineRow>>((resolve, reject) => {
    pendingTimelineRowsByRequestId.set(requestId, { resolve, reject });
    worker["postMessage"]({
      requestId,
      cacheKey,
      input,
    } satisfies TimelineRowsWorkerRequest);
  }).finally(() => {
    inflightTimelineRowsByCacheKey.delete(cacheKey);
  });

  inflightTimelineRowsByCacheKey.set(cacheKey, promise);
  return promise;
}

export function prewarmTimelineRows(cacheKey: string, input: BuildTimelineRowsInput): void {
  if (readCachedTimelineRows(cacheKey)) {
    return;
  }
  void requestTimelineRows(cacheKey, input).catch(() => {
    writeCachedTimelineRows(cacheKey, input, buildTimelineRows(input));
  });
}
