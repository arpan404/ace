import { buildNativeTimelineRows, type NativeTimelineRowsInput } from "./nativeTimelineRows";
import type { TimelineRow } from "./timelineRows";

interface NativeTimelineRowsWorkerRequest {
  readonly id: number;
  readonly input: NativeTimelineRowsInput;
}

interface NativeTimelineRowsWorkerResponse {
  readonly id: number;
  readonly rows?: TimelineRow[];
  readonly error?: string;
}

interface PendingNativeTimelineRowsRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (rows: TimelineRow[]) => void;
}

let nextRequestId = 1;
let nativeTimelineRowsWorker: Worker | null = null;
const pendingRequests = new Map<number, PendingNativeTimelineRowsRequest>();
const MAX_NATIVE_TIMELINE_ROWS_CACHE_ENTRIES = 8;
const NATIVE_TIMELINE_ROWS_CACHE_VERSION = "native-timeline-rows:v3";
const nativeTimelineRowsCache = new Map<string, TimelineRow[]>();

export interface NativeTimelineRowsCacheKeyInput {
  readonly activeTurnStartedAt: string | null;
  readonly completionEndedAt?: string | null;
  readonly completionDividerBeforeEntryId: string | null;
  readonly completionSummary: string | null;
  readonly completionStartedAt?: string | null;
  readonly completionTurnId?: string | null;
  readonly isActiveTurnRunning: boolean;
  readonly rowContentKey: string;
  readonly rowCount: number;
  readonly snapshotRevision: string | null;
  readonly snapshotTotalRows: number | null;
  readonly threadId: string | null;
  readonly threadRevision: number;
  readonly turnDiffSummaryKey: string;
}

export function createNativeTimelineRowsCacheKey(
  input: NativeTimelineRowsCacheKeyInput,
): string | null {
  if (!input.threadId || input.rowCount <= 0) {
    return null;
  }

  return [
    NATIVE_TIMELINE_ROWS_CACHE_VERSION,
    input.threadId,
    input.snapshotRevision ?? "live",
    input.threadRevision,
    input.snapshotTotalRows ?? input.rowCount,
    input.rowCount,
    input.rowContentKey,
    input.isActiveTurnRunning ? "running" : "settled",
    input.activeTurnStartedAt ?? "",
    input.completionDividerBeforeEntryId ?? "",
    input.completionSummary ?? "",
    input.completionTurnId ?? "",
    input.completionStartedAt ?? "",
    input.completionEndedAt ?? "",
    input.turnDiffSummaryKey,
  ].join("\0");
}

function canUseNativeTimelineRowsWorker(): boolean {
  return typeof Worker !== "undefined" && typeof window !== "undefined";
}

function getNativeTimelineRowsWorker(): Worker | null {
  if (!canUseNativeTimelineRowsWorker()) {
    return null;
  }
  if (nativeTimelineRowsWorker) {
    return nativeTimelineRowsWorker;
  }

  nativeTimelineRowsWorker = new Worker(
    new URL("../../workers/nativeTimelineRows.worker.ts", import.meta.url),
    { type: "module" },
  );
  nativeTimelineRowsWorker.addEventListener(
    "message",
    (event: MessageEvent<NativeTimelineRowsWorkerResponse>) => {
      const pending = pendingRequests.get(event.data.id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(event.data.id);
      if (event.data.error) {
        pending.reject(new Error(event.data.error));
        return;
      }
      pending.resolve(event.data.rows ?? []);
    },
  );
  nativeTimelineRowsWorker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Native timeline rows worker failed");
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    nativeTimelineRowsWorker?.terminate();
    nativeTimelineRowsWorker = null;
  });
  return nativeTimelineRowsWorker;
}

export function readCachedNativeTimelineRows(cacheKey: string | null): TimelineRow[] | null {
  if (!cacheKey) {
    return null;
  }
  return nativeTimelineRowsCache.get(cacheKey) ?? null;
}

export function clearCachedNativeTimelineRows(cacheKey: string): void {
  nativeTimelineRowsCache.delete(cacheKey);
}

function writeCachedNativeTimelineRows(cacheKey: string, rows: TimelineRow[]): void {
  nativeTimelineRowsCache.delete(cacheKey);
  nativeTimelineRowsCache.set(cacheKey, rows);
  while (nativeTimelineRowsCache.size > MAX_NATIVE_TIMELINE_ROWS_CACHE_ENTRIES) {
    const oldestKey = nativeTimelineRowsCache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    nativeTimelineRowsCache.delete(oldestKey);
  }
}

export function resolveNativeTimelineRows(input: {
  readonly cacheKey: string;
  readonly rowsInput: NativeTimelineRowsInput;
}): Promise<TimelineRow[]> {
  const cachedRows = nativeTimelineRowsCache.get(input.cacheKey);
  if (cachedRows) {
    return Promise.resolve(cachedRows);
  }
  const worker = getNativeTimelineRowsWorker();
  if (!worker) {
    const rows = buildNativeTimelineRows(input.rowsInput);
    writeCachedNativeTimelineRows(input.cacheKey, rows);
    return Promise.resolve(rows);
  }

  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      reject,
      resolve: (rows) => {
        writeCachedNativeTimelineRows(input.cacheKey, rows);
        resolve(rows);
      },
    });
    worker.postMessage(
      { id, input: input.rowsInput } satisfies NativeTimelineRowsWorkerRequest,
      [],
    );
  });
}
