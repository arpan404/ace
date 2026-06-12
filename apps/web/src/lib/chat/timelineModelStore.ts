import {
  type OrchestrationGetThreadTimelineRowsSnapshotResult,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type OrchestrationThreadTimelineEntryReference,
  type OrchestrationTimelineRow,
  type ThreadId,
  type OrchestrationReadModel,
} from "@ace/contracts";
import { create } from "zustand";

import { ensureNativeApi } from "../../nativeApi";
import { LRUCache } from "../lruCache";
import { clampCacheEntryCount } from "../resourceProfile";

const DEFAULT_TIMELINE_TAIL_WINDOW_ROWS = 100;
const BACKGROUND_TIMELINE_ROWS_PREFETCH_DELAY_MS = 750;
const TIMELINE_ROWS_SNAPSHOT_RPC_TIMEOUT_MS = 10_000;
const TIMELINE_MODEL_CACHE_VERSION = "timeline-model:v4";
const MAX_ROW_HEIGHT_CACHE_ENTRIES = clampCacheEntryCount(32_000, {
  moderateCapEntries: 16_000,
  constrainedCapEntries: 8_000,
});

export interface TimelineRowsMetadata {
  readonly cacheVersion?: string;
  readonly threadId: ThreadId;
  readonly revision: string;
  readonly updatedAt: string;
  readonly totalRows: number;
  readonly tailStartRowIndex: number;
}

export interface TimelineRowsFetchState {
  readonly inFlightCount: number;
  readonly lastSettledAt: number | null;
  readonly startedAt: number | null;
}

export interface TimelineRowsCompleteSnapshot {
  readonly cacheVersion?: string;
  readonly revision: string;
  readonly totalRows: number;
  readonly loadedAt: number;
}

export interface TimelineRowsActiveWindow {
  readonly startRowIndex: number;
  readonly endRowIndexExclusive: number;
  readonly overscanStartRowIndex: number;
  readonly overscanEndRowIndexExclusive: number;
  readonly revision: string | null;
}

export interface TimelineRowsProjection {
  readonly rowIds: readonly string[];
  readonly rows: readonly OrchestrationTimelineRow[];
  readonly messages: readonly OrchestrationMessage[];
  readonly activities: readonly OrchestrationThreadActivity[];
  readonly proposedPlans: readonly OrchestrationProposedPlan[];
  readonly timelineIndexByEntryId: ReadonlyMap<string, number>;
}

interface TimelineRowsProjectionCacheEntry {
  readonly projection: TimelineRowsProjection;
  readonly rowIds: readonly string[];
  readonly threadRevision: number;
}

export type TimelineRowsWindowSlot =
  | {
      readonly kind: "row";
      readonly rowIndex: number;
      readonly rowId: string;
      readonly row: OrchestrationTimelineRow;
    }
  | {
      readonly kind: "placeholder";
      readonly rowIndex: number;
      readonly rowId: string;
    };

export interface TimelineRowsWindowProjection {
  readonly threadId: ThreadId;
  readonly revision: string | null;
  readonly totalRows: number;
  readonly startRowIndex: number;
  readonly endRowIndexExclusive: number;
  readonly slots: readonly TimelineRowsWindowSlot[];
}

interface PrimeLiveTimelineRowInput {
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly entry: Omit<OrchestrationThreadTimelineEntryReference, "index">;
  readonly message?: OrchestrationMessage;
  readonly activity?: OrchestrationThreadActivity;
  readonly proposedPlan?: OrchestrationProposedPlan;
}

interface PrimeLiveTimelineRowOptions {
  readonly flush?: "frame" | "sync";
}

interface RemoveLiveTimelineRowInput {
  readonly threadId: ThreadId;
  readonly kind: OrchestrationThreadTimelineEntryReference["kind"];
  readonly id: string;
}

interface RemoveLiveTimelineRowOptions {
  readonly flush?: "frame" | "sync";
}

function mergeQueuedLiveTimelineRowPatch(
  pending: PrimeLiveTimelineRowInput,
  input: PrimeLiveTimelineRowInput,
): PrimeLiveTimelineRowInput {
  const message =
    pending.message && input.message
      ? chooseFreshestMessage(pending.message, input.message)
      : (input.message ?? pending.message);
  const activity = input.activity ?? pending.activity;
  const proposedPlan =
    pending.proposedPlan && input.proposedPlan
      ? chooseFreshestProposedPlan(pending.proposedPlan, input.proposedPlan)
      : (input.proposedPlan ?? pending.proposedPlan);
  return {
    ...input,
    ...(message ? { message } : {}),
    ...(activity ? { activity } : {}),
    ...(proposedPlan ? { proposedPlan } : {}),
  };
}

interface TimelineModelState {
  readonly metadataByThreadId: Record<string, TimelineRowsMetadata>;
  readonly rowIdsByThreadId: Record<string, readonly string[]>;
  readonly rowsById: Record<string, OrchestrationTimelineRow>;
  readonly messagesById: Record<string, OrchestrationMessage>;
  readonly activitiesById: Record<string, OrchestrationThreadActivity>;
  readonly proposedPlansById: Record<string, OrchestrationProposedPlan>;
  readonly activeWindowByThreadId: Record<string, TimelineRowsActiveWindow>;
  readonly completeSnapshotByThreadId: Record<string, TimelineRowsCompleteSnapshot>;
  readonly fetchStateByThreadId: Record<string, TimelineRowsFetchState>;
  readonly revisionByThreadId: Record<string, number>;
  readonly revision: number;
  readonly rowHeightRevision: number;
  readonly beginFetches: (threadId: ThreadId, count: number) => void;
  readonly finishFetches: (threadId: ThreadId, count: number) => void;
  readonly primeMetadata: (metadata: TimelineRowsMetadata) => void;
  readonly primeSnapshot: (snapshot: OrchestrationGetThreadTimelineRowsSnapshotResult) => void;
  readonly patchRow: (threadId: ThreadId, row: OrchestrationTimelineRow) => void;
  readonly setActiveWindow: (threadId: ThreadId, window: TimelineRowsActiveWindow) => void;
  readonly noteRowHeightWrite: () => void;
  readonly clearThread: (threadId: ThreadId) => void;
  readonly reset: () => void;
}

const rowHeightCache = new LRUCache<number>(
  MAX_ROW_HEIGHT_CACHE_ENTRIES,
  MAX_ROW_HEIGHT_CACHE_ENTRIES * 24,
);
const inFlightRowsSnapshotByThreadId = new Map<
  ThreadId,
  Promise<OrchestrationGetThreadTimelineRowsSnapshotResult>
>();
const projectionCacheByThreadId = new Map<string, TimelineRowsProjectionCacheEntry>();
const liveTimelineRowPatchQueue = new Map<string, PrimeLiveTimelineRowInput>();
const liveTimelineRowRemovalQueue = new Map<string, RemoveLiveTimelineRowInput>();
let liveTimelineRowPatchFrame: number | null = null;
let rowHeightRevisionFrame: number | null = null;

function scheduleAnimationFrame(callback: FrameRequestCallback): number {
  return typeof globalThis.requestAnimationFrame === "function"
    ? globalThis.requestAnimationFrame(callback)
    : (globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number);
}

function cancelScheduledAnimationFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  }
  globalThis.clearTimeout(handle);
}

function cancelLiveTimelineRowPatchFrame(): void {
  if (liveTimelineRowPatchFrame !== null) {
    cancelScheduledAnimationFrame(liveTimelineRowPatchFrame);
    liveTimelineRowPatchFrame = null;
  }
  liveTimelineRowPatchQueue.clear();
  liveTimelineRowRemovalQueue.clear();
}

function cancelRowHeightRevisionFrame(): void {
  if (rowHeightRevisionFrame === null) {
    return;
  }
  cancelScheduledAnimationFrame(rowHeightRevisionFrame);
  rowHeightRevisionFrame = null;
}

function createTimelineRowsSnapshotTimeout(threadId: ThreadId): Promise<never> {
  return new Promise((_, reject) => {
    globalThis.setTimeout(() => {
      reject(
        new Error(
          `Timed out loading timeline snapshot for thread ${String(
            threadId,
          )} after ${String(TIMELINE_ROWS_SNAPSHOT_RPC_TIMEOUT_MS)}ms.`,
        ),
      );
    }, TIMELINE_ROWS_SNAPSHOT_RPC_TIMEOUT_MS);
  });
}

function rowKey(threadId: ThreadId, rowId: string): string {
  return `${threadId}:${rowId}`;
}

function rowKindForSourceKind(
  kind: OrchestrationThreadTimelineEntryReference["kind"],
): OrchestrationTimelineRow["kind"] {
  if (kind === "message") return "message";
  if (kind === "activity") return "work";
  return "proposed-plan";
}

function rowIdForSource(
  kind: OrchestrationThreadTimelineEntryReference["kind"],
  id: string,
): string {
  return `${kind}:${id}`;
}

function createInitialTimelineModelState(): Pick<
  TimelineModelState,
  | "activeWindowByThreadId"
  | "activitiesById"
  | "completeSnapshotByThreadId"
  | "fetchStateByThreadId"
  | "metadataByThreadId"
  | "messagesById"
  | "proposedPlansById"
  | "revision"
  | "revisionByThreadId"
  | "rowHeightRevision"
  | "rowIdsByThreadId"
  | "rowsById"
> {
  return {
    metadataByThreadId: {},
    rowIdsByThreadId: {},
    rowsById: {},
    messagesById: {},
    activitiesById: {},
    proposedPlansById: {},
    activeWindowByThreadId: {},
    completeSnapshotByThreadId: {},
    fetchStateByThreadId: {},
    revisionByThreadId: {},
    revision: 0,
    rowHeightRevision: 0,
  };
}

function bumpThreadRevision(state: TimelineModelState, threadId: ThreadId): Record<string, number> {
  return {
    ...state.revisionByThreadId,
    [threadId]: (state.revisionByThreadId[threadId] ?? 0) + 1,
  };
}

type TimelineMessageAttachment = NonNullable<OrchestrationMessage["attachments"]>[number] & {
  readonly previewUrl?: string;
};

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

function normalizeTimelineMessageAttachments(
  attachments: OrchestrationMessage["attachments"],
): OrchestrationMessage["attachments"] {
  if (!attachments || attachments.length === 0) {
    return attachments;
  }
  return attachments.map((attachment) => {
    const previewUrl = (attachment as TimelineMessageAttachment).previewUrl;
    if (previewUrl) {
      return attachment;
    }
    return {
      ...attachment,
      previewUrl: attachmentPreviewRoutePath(String(attachment.id)),
    };
  }) as OrchestrationMessage["attachments"];
}

function mergeTimelineMessageAttachments(
  existing: OrchestrationMessage["attachments"],
  incoming: OrchestrationMessage["attachments"],
): OrchestrationMessage["attachments"] {
  const normalizedIncoming = normalizeTimelineMessageAttachments(incoming);
  if (!normalizedIncoming || normalizedIncoming.length === 0) {
    return normalizedIncoming;
  }
  if (!existing || existing.length === 0) {
    return normalizedIncoming;
  }

  const existingById = new Map(
    existing.map((attachment) => [String(attachment.id), attachment as TimelineMessageAttachment]),
  );
  return normalizedIncoming.map((attachment) => {
    const incomingAttachment = attachment as TimelineMessageAttachment;
    if (incomingAttachment.previewUrl) {
      return attachment;
    }
    const existingAttachment = existingById.get(String(attachment.id));
    if (!existingAttachment?.previewUrl) {
      return attachment;
    }
    return {
      ...attachment,
      previewUrl: existingAttachment.previewUrl,
    };
  }) as OrchestrationMessage["attachments"];
}

function normalizeTimelineMessage(message: OrchestrationMessage): OrchestrationMessage {
  const attachments = normalizeTimelineMessageAttachments(message.attachments);
  return attachments && attachments.length > 0 ? { ...message, attachments } : message;
}

function hasRenderableMessageText(message: OrchestrationMessage): boolean {
  return message.text.trim().length > 0;
}

function mergeStreamingMessageText(existingText: string, incomingText: string): string {
  if (incomingText.length === 0) {
    return existingText;
  }
  if (incomingText.startsWith(existingText)) {
    return incomingText;
  }
  if (existingText.endsWith(incomingText)) {
    return existingText;
  }
  return `${existingText}${incomingText}`;
}

function chooseFreshestMessage(
  existing: OrchestrationMessage | undefined,
  incoming: OrchestrationMessage,
): OrchestrationMessage {
  if (!existing) {
    return normalizeTimelineMessage(incoming);
  }
  const normalizedIncoming = normalizeTimelineMessage(incoming);
  const updatedAtComparison = existing.updatedAt.localeCompare(incoming.updatedAt);
  if (updatedAtComparison > 0) {
    return existing;
  }
  if (
    updatedAtComparison === 0 &&
    existing.streaming &&
    existing.text.length > incoming.text.length
  ) {
    return existing;
  }
  if (normalizedIncoming.streaming && existing.streaming) {
    const attachments = mergeTimelineMessageAttachments(
      existing.attachments,
      normalizedIncoming.attachments,
    );
    return {
      ...normalizedIncoming,
      text: mergeStreamingMessageText(existing.text, normalizedIncoming.text),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
  }
  if (
    existing.role === "assistant" &&
    normalizedIncoming.role === "assistant" &&
    existing.text.length > normalizedIncoming.text.length &&
    (existing.streaming ||
      normalizedIncoming.streaming ||
      normalizedIncoming.sequence === undefined ||
      existing.sequence === undefined ||
      normalizedIncoming.sequence <= existing.sequence)
  ) {
    const attachments = mergeTimelineMessageAttachments(
      existing.attachments,
      normalizedIncoming.attachments,
    );
    return {
      ...existing,
      streaming: normalizedIncoming.streaming,
      updatedAt: normalizedIncoming.updatedAt,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
  }
  if (!hasRenderableMessageText(normalizedIncoming) && hasRenderableMessageText(existing)) {
    const attachments = mergeTimelineMessageAttachments(
      existing.attachments,
      normalizedIncoming.attachments,
    );
    return {
      ...existing,
      streaming: normalizedIncoming.streaming,
      updatedAt: normalizedIncoming.updatedAt,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
  }
  const attachments = mergeTimelineMessageAttachments(
    existing.attachments,
    normalizedIncoming.attachments,
  );
  return attachments && attachments.length > 0
    ? { ...normalizedIncoming, attachments }
    : normalizedIncoming;
}

function chooseFreshestProposedPlan(
  existing: OrchestrationProposedPlan | undefined,
  incoming: OrchestrationProposedPlan,
): OrchestrationProposedPlan {
  if (!existing) {
    return incoming;
  }
  return existing.updatedAt.localeCompare(incoming.updatedAt) > 0 ? existing : incoming;
}

function compareTimelineRowsBySourceOrder(
  left: OrchestrationTimelineRow,
  right: OrchestrationTimelineRow,
): number {
  return (
    compareLiveTimelineRowSourceSequence(left, right) ||
    left.startSourceIndex - right.startSourceIndex ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareLiveTimelineRowSourceSequence(
  left: OrchestrationTimelineRow,
  right: OrchestrationTimelineRow,
): number {
  if (!isLiveTimelineRow(left) && !isLiveTimelineRow(right)) {
    return 0;
  }
  const leftSequence = timelineRowFirstSequence(left);
  const rightSequence = timelineRowFirstSequence(right);
  if (leftSequence === undefined || rightSequence === undefined || leftSequence === rightSequence) {
    return 0;
  }
  return leftSequence - rightSequence;
}

function isLiveTimelineRow(row: OrchestrationTimelineRow): boolean {
  return row.contentVersion.startsWith("live:");
}

function timelineRowFirstSequence(row: OrchestrationTimelineRow): number | undefined {
  let sequence: number | undefined;
  for (const sourceRef of row.sourceRefs) {
    if (sourceRef.sequence === undefined) {
      continue;
    }
    sequence = sequence === undefined ? sourceRef.sequence : Math.min(sequence, sourceRef.sequence);
  }
  return sequence;
}

function sortTimelineRowIds(
  rowIds: readonly string[],
  threadId: ThreadId,
  rowsById: Readonly<Record<string, OrchestrationTimelineRow>>,
): string[] {
  return rowIds.toSorted((leftId, rightId) => {
    const left = rowsById[rowKey(threadId, leftId)];
    const right = rowsById[rowKey(threadId, rightId)];
    if (!left || !right) {
      return leftId.localeCompare(rightId);
    }
    return compareTimelineRowsBySourceOrder(left, right);
  });
}

function primeTimelineRowsSnapshotIntoState(
  state: TimelineModelState,
  snapshot: OrchestrationGetThreadTimelineRowsSnapshotResult,
): TimelineModelState {
  const snapshotRowIds = new Set(snapshot.rows.map((row) => row.id));
  const previousRowIds = state.rowIdsByThreadId[snapshot.threadId] ?? [];
  const rowsById = { ...state.rowsById };
  for (const previousRowId of previousRowIds) {
    if (snapshotRowIds.has(previousRowId)) {
      continue;
    }
    const previousRow = rowsById[rowKey(snapshot.threadId, previousRowId)];
    if (!previousRow || previousRow.startSourceIndex < snapshot.totalRows) {
      delete rowsById[rowKey(snapshot.threadId, previousRowId)];
    }
  }
  for (const row of snapshot.rows) {
    const existingRow = rowsById[rowKey(snapshot.threadId, row.id)];
    if (
      existingRow &&
      existingRow.updatedAt.localeCompare(row.updatedAt) > 0 &&
      existingRow.startSourceIndex >= row.startSourceIndex
    ) {
      continue;
    }
    rowsById[rowKey(snapshot.threadId, row.id)] = row;
  }

  const sortedRowIds: string[] = [];
  const seenRowIds = new Set<string>();
  let totalRows = snapshot.totalRows;
  for (const row of snapshot.rows) {
    if (seenRowIds.has(row.id)) {
      continue;
    }
    sortedRowIds.push(row.id);
    seenRowIds.add(row.id);
    const storedRow = rowsById[rowKey(snapshot.threadId, row.id)];
    if (storedRow) {
      totalRows = Math.max(totalRows, storedRow.endSourceIndexExclusive);
    }
  }
  for (const rowId of previousRowIds) {
    if (seenRowIds.has(rowId)) {
      continue;
    }
    const row = rowsById[rowKey(snapshot.threadId, rowId)];
    if (!row) {
      continue;
    }
    sortedRowIds.push(rowId);
    seenRowIds.add(rowId);
    totalRows = Math.max(totalRows, row.endSourceIndexExclusive);
  }

  const messagesById = { ...state.messagesById };
  for (const message of snapshot.messages) {
    messagesById[String(message.id)] = chooseFreshestMessage(
      messagesById[String(message.id)],
      message,
    );
  }
  const activitiesById = { ...state.activitiesById };
  for (const activity of snapshot.activities) {
    activitiesById[String(activity.id)] = activity;
  }
  const proposedPlansById = { ...state.proposedPlansById };
  for (const proposedPlan of snapshot.proposedPlans) {
    proposedPlansById[String(proposedPlan.id)] = chooseFreshestProposedPlan(
      proposedPlansById[String(proposedPlan.id)],
      proposedPlan,
    );
  }
  const presentationRowIds = sortTimelineRowIds(sortedRowIds, snapshot.threadId, rowsById);

  const loadedAt = Date.now();

  return {
    ...state,
    metadataByThreadId: {
      ...state.metadataByThreadId,
      [snapshot.threadId]: {
        cacheVersion: TIMELINE_MODEL_CACHE_VERSION,
        threadId: snapshot.threadId,
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        totalRows,
        tailStartRowIndex: Math.max(0, totalRows - DEFAULT_TIMELINE_TAIL_WINDOW_ROWS),
      },
    },
    completeSnapshotByThreadId: {
      ...state.completeSnapshotByThreadId,
      [snapshot.threadId]: {
        cacheVersion: TIMELINE_MODEL_CACHE_VERSION,
        revision: snapshot.revision,
        totalRows,
        loadedAt,
      },
    },
    rowIdsByThreadId: {
      ...state.rowIdsByThreadId,
      [snapshot.threadId]: presentationRowIds,
    },
    rowsById,
    messagesById,
    activitiesById,
    proposedPlansById,
    revisionByThreadId: bumpThreadRevision(state, snapshot.threadId),
    revision: state.revision + 1,
  };
}

export const useTimelineModelStore = create<TimelineModelState>((set) => ({
  ...createInitialTimelineModelState(),
  beginFetches: (threadId, count) =>
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
            startedAt: previous?.startedAt ?? Date.now(),
          },
        },
      };
    }),
  finishFetches: (threadId, count) =>
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
            inFlightCount: Math.max(0, (previous?.inFlightCount ?? 0) - fetchCount),
            lastSettledAt: Date.now(),
            startedAt:
              Math.max(0, (previous?.inFlightCount ?? 0) - fetchCount) > 0
                ? (previous?.startedAt ?? Date.now())
                : null,
          },
        },
      };
    }),
  primeMetadata: (metadata) =>
    set((state) => ({
      ...state,
      metadataByThreadId: {
        ...state.metadataByThreadId,
        [metadata.threadId]: metadata,
      },
      revisionByThreadId: bumpThreadRevision(state, metadata.threadId),
      revision: state.revision + 1,
    })),
  primeSnapshot: (snapshot) => set((state) => primeTimelineRowsSnapshotIntoState(state, snapshot)),
  patchRow: (threadId, row) =>
    set((state) => {
      const rowsById = {
        ...state.rowsById,
        [rowKey(threadId, row.id)]: row,
      };
      const previousRowIds = state.rowIdsByThreadId[threadId] ?? [];
      const nextRowIds = previousRowIds.includes(row.id)
        ? previousRowIds
        : [...previousRowIds, row.id];
      return {
        ...state,
        rowsById,
        rowIdsByThreadId: {
          ...state.rowIdsByThreadId,
          [threadId]: sortTimelineRowIds(nextRowIds, threadId, rowsById),
        },
        revisionByThreadId: bumpThreadRevision(state, threadId),
        revision: state.revision + 1,
      };
    }),
  setActiveWindow: (threadId, window) =>
    set((state) => ({
      ...state,
      activeWindowByThreadId: {
        ...state.activeWindowByThreadId,
        [threadId]: window,
      },
    })),
  noteRowHeightWrite: () =>
    set((state) => ({ ...state, rowHeightRevision: state.rowHeightRevision + 1 })),
  clearThread: (threadId) => {
    projectionCacheByThreadId.delete(threadId);
    set((state) => {
      const { [threadId]: _metadata, ...metadataByThreadId } = state.metadataByThreadId;
      const { [threadId]: rowIds = [], ...rowIdsByThreadId } = state.rowIdsByThreadId;
      const { [threadId]: _fetchState, ...fetchStateByThreadId } = state.fetchStateByThreadId;
      const { [threadId]: _activeWindow, ...activeWindowByThreadId } = state.activeWindowByThreadId;
      const { [threadId]: _completeSnapshot, ...completeSnapshotByThreadId } =
        state.completeSnapshotByThreadId;
      const { [threadId]: _threadRevision, ...revisionByThreadId } = state.revisionByThreadId;
      const rowsById = { ...state.rowsById };
      for (const rowId of rowIds) {
        delete rowsById[rowKey(threadId, rowId)];
      }
      return {
        ...state,
        metadataByThreadId,
        rowIdsByThreadId,
        rowsById,
        activeWindowByThreadId,
        completeSnapshotByThreadId,
        fetchStateByThreadId,
        revisionByThreadId,
        revision: state.revision + 1,
      };
    });
  },
  reset: () => {
    rowHeightCache.clear();
    inFlightRowsSnapshotByThreadId.clear();
    projectionCacheByThreadId.clear();
    cancelLiveTimelineRowPatchFrame();
    cancelRowHeightRevisionFrame();
    set(createInitialTimelineModelState());
  },
}));

function timelineRowsMetadataFromReadModelThread(
  thread: OrchestrationReadModel["threads"][number],
): TimelineRowsMetadata {
  const totalRows = thread.messages.length + thread.activities.length + thread.proposedPlans.length;
  return {
    cacheVersion: TIMELINE_MODEL_CACHE_VERSION,
    threadId: thread.id,
    revision: `${thread.id}:${thread.updatedAt}:${String(totalRows)}`,
    updatedAt: thread.updatedAt,
    totalRows,
    tailStartRowIndex: Math.max(0, totalRows - DEFAULT_TIMELINE_TAIL_WINDOW_ROWS),
  };
}

function timelineRowsMetadataEquals(
  left: TimelineRowsMetadata | undefined,
  right: TimelineRowsMetadata,
): boolean {
  return (
    left?.cacheVersion === right.cacheVersion &&
    left?.threadId === right.threadId &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt &&
    left.totalRows === right.totalRows &&
    left.tailStartRowIndex === right.tailStartRowIndex
  );
}

export function primeThreadTimelineRowsMetadataFromReadModelThread(
  thread: OrchestrationReadModel["threads"][number],
): void {
  useTimelineModelStore.getState().primeMetadata(timelineRowsMetadataFromReadModelThread(thread));
}

export function primeThreadTimelineRowsMetadataFromReadModelThreads(
  threads: ReadonlyArray<OrchestrationReadModel["threads"][number]>,
): void {
  if (threads.length === 0) {
    return;
  }

  useTimelineModelStore.setState((state) => {
    let metadataByThreadId = state.metadataByThreadId;
    let revisionByThreadId = state.revisionByThreadId;
    let changed = false;

    for (const thread of threads) {
      const metadata = timelineRowsMetadataFromReadModelThread(thread);
      if (timelineRowsMetadataEquals(metadataByThreadId[thread.id], metadata)) {
        continue;
      }
      if (!changed) {
        metadataByThreadId = { ...state.metadataByThreadId };
        revisionByThreadId = { ...state.revisionByThreadId };
        changed = true;
      }
      metadataByThreadId[thread.id] = metadata;
      revisionByThreadId[thread.id] = (revisionByThreadId[thread.id] ?? 0) + 1;
    }

    if (!changed) {
      return state;
    }

    return {
      ...state,
      metadataByThreadId,
      revisionByThreadId,
      revision: state.revision + 1,
    };
  });
}

export function isThreadTimelineRowsFullyHydrated(threadId: ThreadId): boolean {
  const state = useTimelineModelStore.getState();
  const metadata = state.metadataByThreadId[threadId];
  const completeSnapshot = state.completeSnapshotByThreadId[threadId];
  if (!metadata || !completeSnapshot) {
    return false;
  }
  const rowIds = state.rowIdsByThreadId[threadId] ?? [];
  return (
    metadata.cacheVersion === TIMELINE_MODEL_CACHE_VERSION &&
    completeSnapshot.cacheVersion === TIMELINE_MODEL_CACHE_VERSION &&
    completeSnapshot.revision === metadata.revision &&
    completeSnapshot.totalRows >= metadata.totalRows &&
    rowIds.length >= metadata.totalRows
  );
}

export async function fetchThreadTimelineRowsSnapshot(
  threadId: ThreadId,
): Promise<OrchestrationGetThreadTimelineRowsSnapshotResult> {
  if (isThreadTimelineRowsFullyHydrated(threadId)) {
    const state = useTimelineModelStore.getState();
    const metadata = state.metadataByThreadId[threadId];
    if (metadata) {
      const projection = readTimelineRowsProjection(threadId);
      return {
        threadId,
        revision: metadata.revision,
        updatedAt: metadata.updatedAt,
        totalRows: metadata.totalRows,
        rows: projection.rows,
        messages: projection.messages,
        activities: projection.activities,
        proposedPlans: projection.proposedPlans,
      };
    }
  }

  const existing = inFlightRowsSnapshotByThreadId.get(threadId);
  if (existing) {
    return existing;
  }

  useTimelineModelStore.getState().beginFetches(threadId, 1);
  const rpcPromise = ensureNativeApi().orchestration.getThreadTimelineRowsSnapshot({ threadId });
  const hydratedSnapshotPromise = rpcPromise.then((snapshot) => {
    useTimelineModelStore.getState().primeSnapshot(snapshot);
    return snapshot;
  });
  void hydratedSnapshotPromise.catch(() => undefined);
  const promise = Promise.race([
    hydratedSnapshotPromise,
    createTimelineRowsSnapshotTimeout(threadId),
  ]).finally(() => {
    inFlightRowsSnapshotByThreadId.delete(threadId);
    useTimelineModelStore.getState().finishFetches(threadId, 1);
  });
  inFlightRowsSnapshotByThreadId.set(threadId, promise);
  return promise;
}

export function hydrateThreadTimelineRowsSnapshotInBackground(threadId: ThreadId): void {
  const existing = inFlightRowsSnapshotByThreadId.get(threadId);
  if (existing) {
    void existing.catch(() => undefined);
    return;
  }

  useTimelineModelStore.getState().beginFetches(threadId, 1);
  let promise: Promise<OrchestrationGetThreadTimelineRowsSnapshotResult>;
  try {
    promise = ensureNativeApi()
      .orchestration.getThreadTimelineRowsSnapshot({ threadId })
      .then((snapshot) => {
        useTimelineModelStore.getState().primeSnapshot(snapshot);
        return snapshot;
      })
      .finally(() => {
        inFlightRowsSnapshotByThreadId.delete(threadId);
        useTimelineModelStore.getState().finishFetches(threadId, 1);
      });
  } catch (error) {
    useTimelineModelStore.getState().finishFetches(threadId, 1);
    void error;
    return;
  }
  inFlightRowsSnapshotByThreadId.set(threadId, promise);
  void promise.catch(() => undefined);
}

export interface ThreadTimelineRowsOpenPrefetchHandle {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

export async function prefetchThreadTimelineRowsSnapshot(input: {
  readonly threadId: ThreadId;
}): Promise<void> {
  if (isThreadTimelineRowsFullyHydrated(input.threadId)) {
    return;
  }
  await fetchThreadTimelineRowsSnapshot(input.threadId);
}

export function startThreadTimelineRowsOpenPrefetch(input: {
  readonly threadId: ThreadId;
  readonly priority?: "background" | "immediate";
}): ThreadTimelineRowsOpenPrefetchHandle {
  let canceled = false;
  const done = (async () => {
    if (input.priority !== "immediate") {
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, BACKGROUND_TIMELINE_ROWS_PREFETCH_DELAY_MS),
      );
    }
    if (canceled) {
      return;
    }
    await prefetchThreadTimelineRowsSnapshot({ threadId: input.threadId });
    if (canceled) {
      return;
    }
  })();
  return {
    done,
    stop: () => {
      canceled = true;
    },
  };
}

export function readTimelineRowsProjection(threadId: ThreadId): TimelineRowsProjection {
  const state = useTimelineModelStore.getState();
  const rowIds = state.rowIdsByThreadId[threadId] ?? [];
  const threadRevision = state.revisionByThreadId[threadId] ?? 0;
  const cachedProjection = projectionCacheByThreadId.get(threadId);
  if (
    cachedProjection &&
    cachedProjection.rowIds === rowIds &&
    cachedProjection.threadRevision === threadRevision
  ) {
    return cachedProjection.projection;
  }

  const rows: OrchestrationTimelineRow[] = [];
  for (const rowId of rowIds) {
    const row = state.rowsById[rowKey(threadId, rowId)];
    if (row) {
      rows.push(row);
    }
  }
  const messages = new Map<string, OrchestrationMessage>();
  const activities = new Map<string, OrchestrationThreadActivity>();
  const proposedPlans = new Map<string, OrchestrationProposedPlan>();
  const timelineIndexByEntryId = new Map<string, number>();

  for (const row of rows) {
    for (const sourceRef of row.sourceRefs) {
      timelineIndexByEntryId.set(`${sourceRef.kind}:${sourceRef.id}`, sourceRef.sourceIndex);
      if (sourceRef.kind === "message") {
        const message = state.messagesById[sourceRef.id];
        if (message) messages.set(String(message.id), message);
      } else if (sourceRef.kind === "activity") {
        const activity = state.activitiesById[sourceRef.id];
        if (activity) activities.set(String(activity.id), activity);
      } else {
        const proposedPlan = state.proposedPlansById[sourceRef.id];
        if (proposedPlan) proposedPlans.set(String(proposedPlan.id), proposedPlan);
      }
    }
  }

  const projection = {
    rowIds,
    rows,
    messages: [...messages.values()],
    activities: [...activities.values()],
    proposedPlans: [...proposedPlans.values()],
    timelineIndexByEntryId,
  };
  projectionCacheByThreadId.set(threadId, {
    projection,
    rowIds,
    threadRevision,
  });
  return projection;
}

export function readTimelineRowsWindowProjection(input: {
  readonly threadId: ThreadId;
  readonly startRowIndex: number;
  readonly endRowIndexExclusive: number;
}): TimelineRowsWindowProjection {
  const state = useTimelineModelStore.getState();
  const metadata = state.metadataByThreadId[input.threadId] ?? null;
  const totalRows = metadata?.totalRows ?? state.rowIdsByThreadId[input.threadId]?.length ?? 0;
  const startRowIndex = Math.min(
    totalRows,
    Math.max(0, Math.trunc(Number.isFinite(input.startRowIndex) ? input.startRowIndex : 0)),
  );
  const endRowIndexExclusive = Math.min(
    totalRows,
    Math.max(
      startRowIndex,
      Math.trunc(
        Number.isFinite(input.endRowIndexExclusive) ? input.endRowIndexExclusive : startRowIndex,
      ),
    ),
  );
  const rowBySourceIndex = new Map<number, OrchestrationTimelineRow>();
  for (const rowId of state.rowIdsByThreadId[input.threadId] ?? []) {
    const row = state.rowsById[rowKey(input.threadId, rowId)];
    if (!row) {
      continue;
    }
    rowBySourceIndex.set(row.startSourceIndex, row);
  }
  const slots: TimelineRowsWindowSlot[] = [];
  for (let rowIndex = startRowIndex; rowIndex < endRowIndexExclusive; rowIndex += 1) {
    const row = rowBySourceIndex.get(rowIndex);
    if (row) {
      slots.push({ kind: "row", rowIndex, rowId: row.id, row });
    } else {
      slots.push({
        kind: "placeholder",
        rowIndex,
        rowId: `placeholder:${input.threadId}:${String(rowIndex)}`,
      });
    }
  }
  return {
    threadId: input.threadId,
    revision: metadata?.revision ?? null,
    totalRows,
    startRowIndex,
    endRowIndexExclusive,
    slots,
  };
}

export function primeLiveTimelineRow(
  input: PrimeLiveTimelineRowInput,
  options: PrimeLiveTimelineRowOptions = {},
): void {
  const queueKey = `${input.threadId}:${input.entry.kind}:${String(input.entry.id)}`;
  if (options.flush === "sync") {
    liveTimelineRowPatchQueue.delete(queueKey);
    liveTimelineRowRemovalQueue.delete(queueKey);
    applyLiveTimelineRowPatches([input]);
    return;
  }
  liveTimelineRowRemovalQueue.delete(queueKey);
  const pending = liveTimelineRowPatchQueue.get(queueKey);
  liveTimelineRowPatchQueue.set(
    queueKey,
    pending ? mergeQueuedLiveTimelineRowPatch(pending, input) : input,
  );
  scheduleLiveTimelineRowQueueFlush();
}

export function removeLiveTimelineRow(
  input: RemoveLiveTimelineRowInput,
  options: RemoveLiveTimelineRowOptions = {},
): void {
  removeLiveTimelineRows([input], options);
}

export function removeLiveTimelineRows(
  inputs: readonly RemoveLiveTimelineRowInput[],
  options: RemoveLiveTimelineRowOptions = {},
): void {
  if (inputs.length === 0) {
    return;
  }
  for (const input of inputs) {
    const queueKey = `${input.threadId}:${input.kind}:${input.id}`;
    liveTimelineRowPatchQueue.delete(queueKey);
  }
  if (options.flush === "sync") {
    applyLiveTimelineRowRemovals(inputs);
    return;
  }
  for (const input of inputs) {
    liveTimelineRowRemovalQueue.set(`${input.threadId}:${input.kind}:${input.id}`, input);
  }
  scheduleLiveTimelineRowQueueFlush();
}

function scheduleLiveTimelineRowQueueFlush(): void {
  if (liveTimelineRowPatchFrame !== null) {
    return;
  }
  liveTimelineRowPatchFrame = scheduleAnimationFrame(() => {
    liveTimelineRowPatchFrame = null;
    const removals = [...liveTimelineRowRemovalQueue.values()];
    const patches = [...liveTimelineRowPatchQueue.values()];
    liveTimelineRowRemovalQueue.clear();
    liveTimelineRowPatchQueue.clear();
    applyLiveTimelineRowQueue({ removals, patches });
  });
}

function applyLiveTimelineRowQueue(input: {
  readonly patches: readonly PrimeLiveTimelineRowInput[];
  readonly removals: readonly RemoveLiveTimelineRowInput[];
}): void {
  if (input.patches.length === 0 && input.removals.length === 0) {
    return;
  }
  useTimelineModelStore.setState((state) =>
    applyLiveTimelineRowPatchesToState(
      applyLiveTimelineRowRemovalsToState(state, input.removals),
      input.patches,
    ),
  );
}

function applyLiveTimelineRowRemovals(inputs: readonly RemoveLiveTimelineRowInput[]): void {
  if (inputs.length === 0) {
    return;
  }
  useTimelineModelStore.setState((state) => {
    return applyLiveTimelineRowRemovalsToState(state, inputs);
  });
}

function applyLiveTimelineRowRemovalsToState(
  state: TimelineModelState,
  inputs: readonly RemoveLiveTimelineRowInput[],
): TimelineModelState {
  if (inputs.length === 0) {
    return state;
  }

  let metadataByThreadId = state.metadataByThreadId;
  let rowIdsByThreadId = state.rowIdsByThreadId;
  let rowsById = state.rowsById;
  let messagesById = state.messagesById;
  let activitiesById = state.activitiesById;
  let proposedPlansById = state.proposedPlansById;
  let revisionByThreadId = state.revisionByThreadId;
  let changed = false;
  const changedThreadIds = new Set<ThreadId>();

  for (const input of inputs) {
    const rowId = rowIdForSource(input.kind, input.id);
    const rowStoreKey = rowKey(input.threadId, rowId);
    const previousRowIds = rowIdsByThreadId[input.threadId] ?? [];
    if (!previousRowIds.includes(rowId) && rowsById[rowStoreKey] === undefined) {
      continue;
    }

    if (!changed) {
      metadataByThreadId = { ...state.metadataByThreadId };
      rowIdsByThreadId = { ...state.rowIdsByThreadId };
      rowsById = { ...state.rowsById };
      messagesById = { ...state.messagesById };
      activitiesById = { ...state.activitiesById };
      proposedPlansById = { ...state.proposedPlansById };
      revisionByThreadId = { ...state.revisionByThreadId };
      changed = true;
    }

    const nextRowIds = previousRowIds.filter((existingRowId) => existingRowId !== rowId);
    rowIdsByThreadId[input.threadId] = nextRowIds;
    delete rowsById[rowStoreKey];
    if (input.kind === "message") {
      delete messagesById[input.id];
    } else if (input.kind === "activity") {
      delete activitiesById[input.id];
    } else {
      delete proposedPlansById[input.id];
    }

    const previousMetadata = metadataByThreadId[input.threadId];
    if (previousMetadata) {
      metadataByThreadId[input.threadId] = {
        ...previousMetadata,
        totalRows: nextRowIds.length,
        tailStartRowIndex: Math.max(0, nextRowIds.length - DEFAULT_TIMELINE_TAIL_WINDOW_ROWS),
        updatedAt: new Date().toISOString(),
      };
    }
    changedThreadIds.add(input.threadId);
  }

  if (!changed) {
    return state;
  }

  for (const threadId of changedThreadIds) {
    revisionByThreadId[threadId] = (revisionByThreadId[threadId] ?? 0) + 1;
  }

  return {
    ...state,
    metadataByThreadId,
    rowIdsByThreadId,
    rowsById,
    messagesById,
    activitiesById,
    proposedPlansById,
    revisionByThreadId,
    revision: state.revision + 1,
  };
}

function applyLiveTimelineRowPatches(patches: readonly PrimeLiveTimelineRowInput[]): void {
  if (patches.length === 0) {
    return;
  }
  useTimelineModelStore.setState((state) => applyLiveTimelineRowPatchesToState(state, patches));
}

function resolveNextLiveTimelineSourceIndex(input: {
  readonly metadataByThreadId: Readonly<Record<string, TimelineRowsMetadata>>;
  readonly nextSourceIndexByThreadId: Map<ThreadId, number>;
  readonly rowIdsByThreadId: Readonly<Record<string, readonly string[]>>;
  readonly rowsById: Readonly<Record<string, OrchestrationTimelineRow>>;
  readonly threadId: ThreadId;
}): number {
  const cached = input.nextSourceIndexByThreadId.get(input.threadId);
  if (cached !== undefined) {
    return cached;
  }

  let nextSourceIndex = input.metadataByThreadId[input.threadId]?.totalRows ?? 0;
  for (const existingRowId of input.rowIdsByThreadId[input.threadId] ?? []) {
    const existingRow = input.rowsById[rowKey(input.threadId, existingRowId)];
    if (!existingRow) {
      continue;
    }
    nextSourceIndex = Math.max(nextSourceIndex, existingRow.endSourceIndexExclusive);
  }
  input.nextSourceIndexByThreadId.set(input.threadId, nextSourceIndex);
  return nextSourceIndex;
}

function applyLiveTimelineRowPatchesToState(
  state: TimelineModelState,
  patches: readonly PrimeLiveTimelineRowInput[],
): TimelineModelState {
  if (patches.length === 0) {
    return state;
  }

  let metadataByThreadId = state.metadataByThreadId;
  let completeSnapshotByThreadId = state.completeSnapshotByThreadId;
  let rowIdsByThreadId = state.rowIdsByThreadId;
  let rowsById = state.rowsById;
  let messagesById = state.messagesById;
  let activitiesById = state.activitiesById;
  let proposedPlansById = state.proposedPlansById;
  const changedThreadIds = new Set<ThreadId>();
  const threadsNeedingSort = new Set<ThreadId>();
  const nextSourceIndexByThreadId = new Map<ThreadId, number>();
  let changed = false;

  for (const input of patches) {
    const previousMetadata = metadataByThreadId[input.threadId];
    const rowId = rowIdForSource(input.entry.kind, String(input.entry.id));
    const previousRow = rowsById[rowKey(input.threadId, rowId)];
    const threadRowIds = rowIdsByThreadId[input.threadId] ?? [];
    const sourceIndex =
      previousRow?.startSourceIndex ??
      resolveNextLiveTimelineSourceIndex({
        metadataByThreadId,
        nextSourceIndexByThreadId,
        rowIdsByThreadId,
        rowsById,
        threadId: input.threadId,
      });
    const row: OrchestrationTimelineRow = {
      id: rowId,
      kind: rowKindForSourceKind(input.entry.kind),
      createdAt: input.entry.createdAt,
      updatedAt: input.updatedAt,
      contentVersion: [
        "live",
        input.entry.kind,
        String(input.entry.id),
        input.updatedAt,
        input.message?.text.length ??
          input.activity?.summary.length ??
          input.proposedPlan?.planMarkdown.length ??
          0,
      ].join(":"),
      startSourceIndex: sourceIndex,
      endSourceIndexExclusive: sourceIndex + 1,
      ...(input.entry.turnId !== undefined ? { turnId: input.entry.turnId } : {}),
      sourceRefs: [
        {
          kind: input.entry.kind,
          id: String(input.entry.id),
          createdAt: input.entry.createdAt,
          sourceIndex,
          ...(input.entry.turnId !== undefined ? { turnId: input.entry.turnId } : {}),
          ...(input.entry.sequence !== undefined ? { sequence: input.entry.sequence } : {}),
        },
      ],
    };

    if (!changed) {
      metadataByThreadId = { ...state.metadataByThreadId };
      rowsById = { ...state.rowsById };
      changed = true;
    }

    rowsById[rowKey(input.threadId, row.id)] = row;
    nextSourceIndexByThreadId.set(
      input.threadId,
      Math.max(nextSourceIndexByThreadId.get(input.threadId) ?? 0, row.endSourceIndexExclusive),
    );

    const isExistingRow = threadRowIds.includes(rowId);
    const nextThreadRowIds = isExistingRow ? threadRowIds : [...threadRowIds, rowId];
    if (!isExistingRow) {
      if (rowIdsByThreadId === state.rowIdsByThreadId) {
        rowIdsByThreadId = { ...state.rowIdsByThreadId };
      }
      rowIdsByThreadId[input.threadId] = nextThreadRowIds;
      threadsNeedingSort.add(input.threadId);
    }

    const nextTotalRows = Math.max(
      previousMetadata?.totalRows ?? 0,
      row.endSourceIndexExclusive,
      nextThreadRowIds.length,
    );
    metadataByThreadId[input.threadId] = {
      threadId: input.threadId,
      revision: previousMetadata?.revision ?? `live:${input.threadId}`,
      updatedAt: input.updatedAt,
      totalRows: nextTotalRows,
      tailStartRowIndex: Math.max(0, nextTotalRows - DEFAULT_TIMELINE_TAIL_WINDOW_ROWS),
    };

    const previousCompleteSnapshot = completeSnapshotByThreadId[input.threadId];
    if (previousCompleteSnapshot) {
      if (completeSnapshotByThreadId === state.completeSnapshotByThreadId) {
        completeSnapshotByThreadId = { ...state.completeSnapshotByThreadId };
      }
      completeSnapshotByThreadId[input.threadId] = {
        ...previousCompleteSnapshot,
        totalRows: Math.max(previousCompleteSnapshot.totalRows, nextTotalRows),
      };
    }

    if (input.message) {
      if (messagesById === state.messagesById) {
        messagesById = { ...state.messagesById };
      }
      messagesById[String(input.message.id)] = chooseFreshestMessage(
        messagesById[String(input.message.id)],
        input.message,
      );
    }
    if (input.activity) {
      if (activitiesById === state.activitiesById) {
        activitiesById = { ...state.activitiesById };
      }
      activitiesById[String(input.activity.id)] = input.activity;
    }
    if (input.proposedPlan) {
      if (proposedPlansById === state.proposedPlansById) {
        proposedPlansById = { ...state.proposedPlansById };
      }
      proposedPlansById[String(input.proposedPlan.id)] = chooseFreshestProposedPlan(
        proposedPlansById[String(input.proposedPlan.id)],
        input.proposedPlan,
      );
    }
    changedThreadIds.add(input.threadId);
  }

  if (!changed) {
    return state;
  }

  for (const threadId of threadsNeedingSort) {
    rowIdsByThreadId[threadId] = sortTimelineRowIds(
      rowIdsByThreadId[threadId] ?? [],
      threadId,
      rowsById,
    );
  }

  let revisionByThreadId = state.revisionByThreadId;
  for (const threadId of changedThreadIds) {
    if (revisionByThreadId === state.revisionByThreadId) {
      revisionByThreadId = { ...state.revisionByThreadId };
    }
    revisionByThreadId[threadId] = (revisionByThreadId[threadId] ?? 0) + 1;
  }

  return {
    ...state,
    metadataByThreadId,
    completeSnapshotByThreadId,
    rowIdsByThreadId,
    rowsById,
    messagesById,
    activitiesById,
    proposedPlansById,
    revisionByThreadId,
    revision: state.revision + 1,
  };
}

export function readTimelineRow(
  threadId: ThreadId,
  rowId: string,
): OrchestrationTimelineRow | null {
  return useTimelineModelStore.getState().rowsById[rowKey(threadId, rowId)] ?? null;
}

export function writeTimelineModelRowHeight(rowId: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) {
    return;
  }
  const previousHeight = rowHeightCache.get(rowId);
  if (
    previousHeight !== null &&
    previousHeight !== undefined &&
    Math.abs(previousHeight - height) < 1
  ) {
    return;
  }
  rowHeightCache.set(rowId, height, 24);
  scheduleRowHeightRevisionWrite();
}

export function readTimelineModelRowHeight(rowId: string): number | null {
  return rowHeightCache.get(rowId);
}

function scheduleRowHeightRevisionWrite(): void {
  if (rowHeightRevisionFrame !== null) {
    return;
  }
  rowHeightRevisionFrame = scheduleAnimationFrame(() => {
    rowHeightRevisionFrame = null;
    useTimelineModelStore.getState().noteRowHeightWrite();
  });
}
