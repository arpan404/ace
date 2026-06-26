import { buildSourceTimelineRows, type SourceTimelineRowsInput } from "./sourceTimelineRows";
import type { TimelineRow } from "./timelineRows";

interface SourceTimelineRowsWorkerRequest {
  readonly id: number;
  readonly input: SourceTimelineRowsInput;
}

interface SourceTimelineRowsWorkerResponse {
  readonly id: number;
  readonly rows?: TimelineRow[];
  readonly error?: string;
}

interface PendingSourceTimelineRowsRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (rows: TimelineRow[]) => void;
}

let nextRequestId = 1;
let sourceTimelineRowsWorker: Worker | null = null;
const pendingRequests = new Map<number, PendingSourceTimelineRowsRequest>();
const MAX_SOURCE_TIMELINE_ROWS_CACHE_ENTRIES = 8;
const SOURCE_TIMELINE_ROWS_CACHE_VERSION = "source-timeline-rows:v8";
const sourceTimelineRowsCache = new Map<string, TimelineRow[]>();

export interface SourceTimelineRowsCacheKeyInput {
  readonly activeTurnId?: string | null;
  readonly activeTurnStartedAt: string | null;
  readonly completionEndedAt?: string | null;
  readonly completionDividerBeforeEntryId: string | null;
  readonly completionSummary: string | null;
  readonly completionStartedAt?: string | null;
  readonly completionTurnId?: string | null;
  readonly hideCompletedWorkMessages: boolean;
  readonly isActiveTurnRunning: boolean;
  readonly rowContentKey: string;
  readonly rowCount: number;
  readonly snapshotRevision: string | null;
  readonly snapshotTotalRows: number | null;
  readonly threadId: string | null;
  readonly threadRevision: number;
  readonly turnDiffSummaryKey: string;
}

export function createSourceTimelineRowsCacheKey(
  input: SourceTimelineRowsCacheKeyInput,
): string | null {
  if (!input.threadId || input.rowCount <= 0) {
    return null;
  }

  return [
    SOURCE_TIMELINE_ROWS_CACHE_VERSION,
    input.threadId,
    input.snapshotRevision ?? "live",
    input.threadRevision,
    input.snapshotTotalRows ?? input.rowCount,
    input.rowCount,
    input.rowContentKey,
    input.isActiveTurnRunning ? "running" : "settled",
    input.activeTurnId ?? "",
    input.activeTurnStartedAt ?? "",
    input.completionDividerBeforeEntryId ?? "",
    input.completionSummary ?? "",
    input.completionTurnId ?? "",
    input.completionStartedAt ?? "",
    input.completionEndedAt ?? "",
    input.hideCompletedWorkMessages ? "hide-completed-work" : "show-completed-work",
    input.turnDiffSummaryKey,
  ].join("\0");
}

function canUseSourceTimelineRowsWorker(): boolean {
  return typeof Worker !== "undefined" && typeof window !== "undefined";
}

function getSourceTimelineRowsWorker(): Worker | null {
  if (!canUseSourceTimelineRowsWorker()) {
    return null;
  }
  if (sourceTimelineRowsWorker) {
    return sourceTimelineRowsWorker;
  }

  sourceTimelineRowsWorker = new Worker(
    new URL("../../workers/sourceTimelineRows.worker.ts", import.meta.url),
    { type: "module" },
  );
  sourceTimelineRowsWorker.addEventListener(
    "message",
    (event: MessageEvent<SourceTimelineRowsWorkerResponse>) => {
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
  sourceTimelineRowsWorker.addEventListener("error", (event) => {
    const error = new Error(event.message || "Source timeline rows worker failed");
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    sourceTimelineRowsWorker?.terminate();
    sourceTimelineRowsWorker = null;
  });
  return sourceTimelineRowsWorker;
}

export function readCachedSourceTimelineRows(cacheKey: string | null): TimelineRow[] | null {
  if (!cacheKey) {
    return null;
  }
  return sourceTimelineRowsCache.get(cacheKey) ?? null;
}

export function clearCachedSourceTimelineRows(cacheKey: string): void {
  sourceTimelineRowsCache.delete(cacheKey);
}

function writeCachedSourceTimelineRows(cacheKey: string, rows: TimelineRow[]): void {
  sourceTimelineRowsCache.delete(cacheKey);
  sourceTimelineRowsCache.set(cacheKey, rows);
  while (sourceTimelineRowsCache.size > MAX_SOURCE_TIMELINE_ROWS_CACHE_ENTRIES) {
    const oldestKey = sourceTimelineRowsCache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    sourceTimelineRowsCache.delete(oldestKey);
  }
}

export function resolveSourceTimelineRows(input: {
  readonly cacheKey: string;
  readonly rowsInput: SourceTimelineRowsInput;
}): Promise<TimelineRow[]> {
  const cachedRows = sourceTimelineRowsCache.get(input.cacheKey);
  if (cachedRows) {
    return Promise.resolve(cachedRows);
  }
  const worker = getSourceTimelineRowsWorker();
  if (!worker) {
    const rows = buildSourceTimelineRows(input.rowsInput);
    writeCachedSourceTimelineRows(input.cacheKey, rows);
    return Promise.resolve(rows);
  }

  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      reject,
      resolve: (rows) => {
        writeCachedSourceTimelineRows(input.cacheKey, rows);
        resolve(rows);
      },
    });
    worker.postMessage(
      { id, input: input.rowsInput } satisfies SourceTimelineRowsWorkerRequest,
      [],
    );
  });
}
