import TimelineRowsWorker from "../../workers/timelineRows.worker?worker";
import { fnv1a32 } from "../diffRendering";
import { LRUCache } from "../lruCache";
import { registerMemoryPressureHandler, shouldBypassNonEssentialCaching } from "../memoryPressure";
import {
  clampCacheBudgetBytes,
  clampCacheEntryCount,
  shouldAvoidSpeculativeWork,
} from "../resourceProfile";
import {
  buildTimelineRows,
  estimateTimelineRowsCacheSize,
  type BuildTimelineRowsInput,
  type TimelineRow,
} from "./timelineRows";
import { TIMELINE_ROWS_PROJECTION_VERSION } from "./timelineRowsProjection";
import { readPersistedTimelineRows, writePersistedTimelineRows } from "./threadTimelineStorage";

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
  readonly projectionVersion: number;
  readonly input: BuildTimelineRowsInput;
}

interface TimelineRowsWorkerSuccess {
  readonly requestId: number;
  readonly cacheKey: string;
  readonly projectionVersion: number;
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
const inflightTimelineRowsStorageByCacheKey = new Map<
  string,
  Promise<ReadonlyArray<TimelineRow> | null>
>();
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
    inflightTimelineRowsStorageByCacheKey.clear();
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
      if (response.projectionVersion !== TIMELINE_ROWS_PROJECTION_VERSION) {
        pending.reject(new Error("Timeline rows worker projection version mismatch."));
        pendingTimelineRowsByRequestId.clear();
        inflightTimelineRowsByCacheKey.clear();
        worker.terminate();
        timelineRowsWorker = undefined;
        return;
      }
      timelineRowsCache.set(
        response.cacheKey,
        response.rows,
        estimateTimelineRowsCacheSize(response.input, response.rows),
      );
      void writePersistedTimelineRows(response.cacheKey, response.rows);
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
    `timeline-rows:v${String(TIMELINE_ROWS_PROJECTION_VERSION)}`,
    input.cacheScopeKey ?? getTimelineEntryToken(input.timelineEntries),
    input.activeTurnInProgress ? "1" : "0",
    input.activeTurnStartedAt ?? "none",
    input.completionDividerBeforeEntryId ?? "none",
    summary.length,
    summaryHash,
    input.hideCompletedWorkMessages === true ? "1" : "0",
    input.isWorking ? "1" : "0",
    input.enableGoalWorkingState === true ? "1" : "0",
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
    void writePersistedTimelineRows(cacheKey, rows);
  }
  return rows;
}

async function readPersistedTimelineRowsForCacheKey(
  cacheKey: string,
): Promise<ReadonlyArray<TimelineRow> | null> {
  const existing = inflightTimelineRowsStorageByCacheKey.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    if (!cacheKey) {
      return null;
    }
    const persistedRows = await readPersistedTimelineRows(cacheKey);
    if (!persistedRows) {
      return null;
    }
    return persistedRows;
  })();

  inflightTimelineRowsStorageByCacheKey.set(cacheKey, promise);
  return promise.finally(() => {
    inflightTimelineRowsStorageByCacheKey.delete(cacheKey);
  });
}

export function resolveTimelineRows(
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

  const promise = (async () => {
    const persistedRows = await readPersistedTimelineRowsForCacheKey(cacheKey);
    if (persistedRows) {
      return writeCachedTimelineRows(cacheKey, input, persistedRows);
    }

    const worker = getTimelineRowsWorker();
    if (!worker || shouldBypassNonEssentialCaching()) {
      const rows = buildTimelineRows(input);
      return writeCachedTimelineRows(cacheKey, input, rows);
    }

    const requestId = nextTimelineRowsRequestId++;
    return new Promise<ReadonlyArray<TimelineRow>>((resolve, reject) => {
      pendingTimelineRowsByRequestId.set(requestId, { resolve, reject });
      worker["postMessage"]({
        requestId,
        cacheKey,
        projectionVersion: TIMELINE_ROWS_PROJECTION_VERSION,
        input,
      } satisfies TimelineRowsWorkerRequest);
    });
  })();

  inflightTimelineRowsByCacheKey.set(cacheKey, promise);
  return promise.finally(() => {
    inflightTimelineRowsByCacheKey.delete(cacheKey);
  });
}

export function prewarmTimelineRows(cacheKey: string, input: BuildTimelineRowsInput): void {
  if (shouldBypassNonEssentialCaching() || shouldAvoidSpeculativeWork()) {
    return;
  }
  if (readCachedTimelineRows(cacheKey)) {
    return;
  }
  void resolveTimelineRows(cacheKey, input).catch(() => {
    writeCachedTimelineRows(cacheKey, input, buildTimelineRows(input));
  });
}
