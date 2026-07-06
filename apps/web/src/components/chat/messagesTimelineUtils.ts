import { type VirtualItem } from "@tanstack/react-virtual";

import {
  buildMarkdownRenderAnalysisCacheKey,
  shouldWorkerizeMarkdownRenderAnalysis,
  type MarkdownRenderAnalysisInput,
} from "../../lib/chat/markdownRenderAnalysis";
import { getChatMessageRenderableText } from "../../lib/chat/messageText";
import {
  isCompletedAssistantMessageRow,
  type AssistantTimelineMessage,
  type TimelineRow,
} from "~/lib/chat/timelineRows";

export const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
export const IMMEDIATE_ASSISTANT_MARKDOWN_TAIL_MESSAGES = 12;
export const ASSISTANT_MARKDOWN_PENDING_LOOKBACK_ROWS = 256;
export const TIMELINE_VIRTUALIZER_OVERSCAN = 16;
export const TIMELINE_FALLBACK_VIRTUAL_RANGE_MIN_ROWS = TIMELINE_VIRTUALIZER_OVERSCAN * 2 + 8;
export const TIMELINE_DIRECTIONAL_PREFETCH_MIN_VELOCITY_PX_PER_MS = 0.75;
export const TIMELINE_BASE_PREFETCH_EDGE_ROWS = Math.max(TIMELINE_VIRTUALIZER_OVERSCAN * 2, 16);

export interface AssistantMarkdownAnalysisPrewarmJob {
  readonly cacheKey: string;
  readonly input: MarkdownRenderAnalysisInput;
}

export type TimelineRenderedWindowState = {
  readonly loadedEndIndexExclusive: number;
  readonly loadedRowCount: number;
  readonly loadedStartIndex: number;
  readonly overscanLoadedEndIndexExclusive: number;
  readonly overscanLoadedStartIndex: number;
};

export function resolveTimelineScrollPrefetchLookaheadRows(velocityPxPerMs: number): number {
  const velocity = Math.max(0, Number.isFinite(velocityPxPerMs) ? velocityPxPerMs : 0);
  if (velocity < 0.75) return TIMELINE_BASE_PREFETCH_EDGE_ROWS;
  if (velocity < 1.5) return 64;
  if (velocity < 3) return 128;
  if (velocity < 6) return 256;
  if (velocity < 10) return 512;
  return 1_024;
}

type TimelineScrollPrefetchDirection = "older" | "newer" | "both";

export function deriveTimelineScrollPrefetchRequest(input: {
  readonly currentScrollTop: number;
  readonly previousScrollTop: number;
  readonly elapsedMs: number;
}): {
  readonly direction: TimelineScrollPrefetchDirection;
  readonly lookaheadRows: number;
  readonly velocityPxPerMs: number;
} {
  const deltaScrollTop = Number.isFinite(input.previousScrollTop)
    ? input.currentScrollTop - input.previousScrollTop
    : 0;
  const elapsedMs = Math.max(1, Number.isFinite(input.elapsedMs) ? input.elapsedMs : 1);
  const velocityPxPerMs = Math.abs(deltaScrollTop) / elapsedMs;
  const direction =
    velocityPxPerMs >= TIMELINE_DIRECTIONAL_PREFETCH_MIN_VELOCITY_PX_PER_MS
      ? deltaScrollTop < 0
        ? "older"
        : deltaScrollTop > 0
          ? "newer"
          : "both"
      : "both";
  return {
    direction,
    lookaheadRows: resolveTimelineScrollPrefetchLookaheadRows(velocityPxPerMs),
    velocityPxPerMs,
  };
}

export function deriveTimelineRenderedWindowState(input: {
  readonly totalRowCount?: number;
  readonly renderedVirtualItems: readonly VirtualItem[];
  readonly virtualizedRows: ReadonlyArray<TimelineRow>;
}): TimelineRenderedWindowState | null {
  const firstVirtualItem = input.renderedVirtualItems[0];
  const lastVirtualItem = input.renderedVirtualItems.at(-1);
  if (!firstVirtualItem || !lastVirtualItem) {
    const totalRowCount = Math.max(0, Math.trunc(input.totalRowCount ?? 0));
    if (input.virtualizedRows.length === 0 && totalRowCount > 0) {
      return {
        loadedEndIndexExclusive: totalRowCount,
        loadedRowCount: totalRowCount,
        loadedStartIndex: 0,
        overscanLoadedEndIndexExclusive: totalRowCount,
        overscanLoadedStartIndex: 0,
      };
    }
    return null;
  }

  return {
    loadedEndIndexExclusive: lastVirtualItem.index + 1,
    loadedRowCount: input.virtualizedRows.length,
    loadedStartIndex: firstVirtualItem.index,
    overscanLoadedEndIndexExclusive: lastVirtualItem.index + 1,
    overscanLoadedStartIndex: firstVirtualItem.index,
  };
}

export function shouldRenderTimelineVirtualizedBuffer(input: {
  readonly virtualizedRowCount: number;
}): boolean {
  return input.virtualizedRowCount > 0;
}

export function deriveFallbackTimelineVirtualItems(input: {
  readonly rowCount: number;
  readonly estimateSize: (index: number) => number;
  readonly getItemKey: (index: number) => VirtualItem["key"];
  readonly overscan: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}): VirtualItem[] {
  if (input.rowCount <= 0) {
    return [];
  }

  const viewportHeight = Math.max(1, input.viewportHeight);
  const starts: number[] = [];
  const sizes: number[] = [];
  let totalSize = 0;
  for (let index = 0; index < input.rowCount; index += 1) {
    const rawSize = input.estimateSize(index);
    const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 96;
    starts.push(totalSize);
    sizes.push(size);
    totalSize += size;
  }

  const maxScrollTop = Math.max(totalSize - viewportHeight, 0);
  const scrollTop = Math.min(Math.max(input.scrollTop, 0), maxScrollTop);
  const visibleStart = Math.max(scrollTop - viewportHeight, 0);
  const visibleEnd = Math.min(scrollTop + viewportHeight * 2, totalSize);

  let startIndex = 0;
  while (
    startIndex < input.rowCount - 1 &&
    (starts[startIndex] ?? 0) + (sizes[startIndex] ?? 0) < visibleStart
  ) {
    startIndex += 1;
  }

  let endIndex = startIndex;
  while (endIndex < input.rowCount - 1 && (starts[endIndex] ?? 0) <= visibleEnd) {
    endIndex += 1;
  }

  startIndex = Math.max(0, startIndex - input.overscan);
  endIndex = Math.min(input.rowCount - 1, endIndex + input.overscan);

  if (endIndex - startIndex + 1 < TIMELINE_FALLBACK_VIRTUAL_RANGE_MIN_ROWS) {
    const missingRows = TIMELINE_FALLBACK_VIRTUAL_RANGE_MIN_ROWS - (endIndex - startIndex + 1);
    const prependRows = Math.min(startIndex, Math.floor(missingRows / 2));
    startIndex -= prependRows;
    endIndex = Math.min(input.rowCount - 1, endIndex + missingRows - prependRows);
  }

  const items: VirtualItem[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const start = starts[index] ?? 0;
    const size = sizes[index] ?? 96;
    items.push({
      key: input.getItemKey(index),
      index,
      start,
      end: start + size,
      size,
      lane: 0,
    });
  }
  return items;
}

export function buildAssistantMarkdownAnalysisStableKey(
  message: AssistantTimelineMessage,
  messageText: string,
): string {
  return `${message.id}:${message.streaming ? "streaming" : (message.completedAt ?? "complete")}:${messageText.length}`;
}

export function buildAssistantMarkdownAnalysisPrewarmJobs(input: {
  rows: ReadonlyArray<TimelineRow>;
  immediateMessageIds: ReadonlyArray<string>;
  pendingMessageIds: ReadonlyArray<string>;
}): AssistantMarkdownAnalysisPrewarmJob[] {
  const requestedMessageIds = [...input.immediateMessageIds, ...input.pendingMessageIds];
  if (requestedMessageIds.length === 0) {
    return [];
  }

  const requestedMessageIdSet = new Set(requestedMessageIds);
  const rowsByMessageId = new Map<string, AssistantTimelineMessage>();
  for (const row of input.rows) {
    if (!isCompletedAssistantMessageRow(row)) {
      continue;
    }
    const messageId = String(row.message.id);
    if (!requestedMessageIdSet.has(messageId)) {
      continue;
    }
    rowsByMessageId.set(messageId, row.message);
  }

  const jobs: AssistantMarkdownAnalysisPrewarmJob[] = [];
  const seenMessageIds = new Set<string>();
  const seenCacheKeys = new Set<string>();
  for (const messageId of requestedMessageIds) {
    if (seenMessageIds.has(messageId)) {
      continue;
    }
    seenMessageIds.add(messageId);

    const message = rowsByMessageId.get(messageId);
    if (!message) {
      continue;
    }

    const messageText = getChatMessageRenderableText(message);
    const jobInput: MarkdownRenderAnalysisInput = {
      text: messageText,
      isStreaming: Boolean(message.streaming),
      renderPlainText: false,
      ...(message.streamingTextState
        ? {
            streamingTextState: {
              totalLineCount: message.streamingTextState.totalLineCount,
              truncatedCharCount: message.streamingTextState.truncatedCharCount,
              truncatedLineCount: message.streamingTextState.truncatedLineCount,
            },
          }
        : {}),
    };
    if (!shouldWorkerizeMarkdownRenderAnalysis(jobInput)) {
      continue;
    }

    const cacheKey = buildMarkdownRenderAnalysisCacheKey(
      jobInput,
      buildAssistantMarkdownAnalysisStableKey(message, messageText),
    );
    if (seenCacheKeys.has(cacheKey)) {
      continue;
    }
    seenCacheKeys.add(cacheKey);
    jobs.push({
      cacheKey,
      input: jobInput,
    });
  }

  return jobs;
}

export function derivePendingAssistantMarkdownMessageIdsBottomUp(
  rows: ReadonlyArray<TimelineRow>,
  input: {
    firstUnvirtualizedRowIndex: number;
    immediateMessageIds: ReadonlySet<string>;
    maxMessageIds?: number;
    maxRows?: number;
    mountedMessageIds: ReadonlySet<string>;
    renderedMessageIds: ReadonlySet<string>;
  },
): string[] {
  const messageIds: string[] = [];
  const maxRows = Math.max(0, Math.trunc(input.maxRows ?? Number.POSITIVE_INFINITY));
  const maxMessageIds = Math.max(0, Math.trunc(input.maxMessageIds ?? Number.POSITIVE_INFINITY));
  const minIndexExclusive =
    Number.isFinite(maxRows) && maxRows > 0
      ? Math.max(0, input.firstUnvirtualizedRowIndex - maxRows)
      : 0;
  for (let index = input.firstUnvirtualizedRowIndex - 1; index >= minIndexExclusive; index -= 1) {
    if (messageIds.length >= maxMessageIds) {
      break;
    }
    const row = rows[index];
    if (!row || !isCompletedAssistantMessageRow(row)) {
      continue;
    }
    const messageId = String(row.message.id);
    if (
      input.immediateMessageIds.has(messageId) ||
      input.mountedMessageIds.has(messageId) ||
      input.renderedMessageIds.has(messageId)
    ) {
      continue;
    }
    messageIds.push(messageId);
  }
  return messageIds;
}

export function deriveFirstUnvirtualizedTimelineRowIndex(
  rows: ReadonlyArray<TimelineRow>,
  input: {
    activeTurnInProgress: boolean;
    activeTurnStartedAt: string | null;
    preserveCurrentTurnTail: boolean;
  },
): number {
  const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
  if (!input.activeTurnInProgress || !input.preserveCurrentTurnTail) {
    return firstTailRowIndex;
  }

  const turnStartedAtMs =
    typeof input.activeTurnStartedAt === "string"
      ? Date.parse(input.activeTurnStartedAt)
      : Number.NaN;
  let firstCurrentTurnRowIndex = -1;
  if (!Number.isNaN(turnStartedAtMs)) {
    firstCurrentTurnRowIndex = rows.findIndex((row) => {
      if (row.kind === "working") return true;
      if (!row.createdAt) return false;
      const rowCreatedAtMs = Date.parse(row.createdAt);
      return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
    });
  }

  if (firstCurrentTurnRowIndex < 0) {
    firstCurrentTurnRowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.role === "assistant" && row.message.streaming,
    );
  }

  if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

  for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
    const previousRow = rows[index];
    if (!previousRow || previousRow.kind !== "message") continue;
    if (previousRow.message.role === "user") {
      return Math.min(index, firstTailRowIndex);
    }
    if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
      break;
    }
  }

  return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
}
