import {
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadId,
} from "@ace/contracts";
import { compareOrchestrationTimelineSources } from "@ace/shared/orchestrationTimelineSources";
import { create } from "zustand";

import { ensureNativeApi } from "../../nativeApi";
import { resolveConnectionForThreadId } from "../connectionRouting";
import { LRUCache } from "../lruCache";
import { clampCacheEntryCount } from "../resourceProfile";
import { resolveAttachmentPreviewUrl } from "./attachmentPreviewUrls";

const DEFAULT_TIMELINE_TAIL_WINDOW_ROWS = 100;
const BACKGROUND_TIMELINE_ROWS_PREFETCH_DELAY_MS = 750;
const THREAD_TIMELINE_HYDRATION_TIMEOUT_MS = 10_000;
const BACKGROUND_TIMELINE_ROWS_PREFETCH_FAILURE_BACKOFF_MS = 30_000;
const TIMELINE_MODEL_CACHE_VERSION = "timeline-model:v4";
const MAX_ROW_HEIGHT_CACHE_ENTRIES = clampCacheEntryCount(32_000, {
  moderateCapEntries: 16_000,
  constrainedCapEntries: 8_000,
});

export type TimelineSourceKind = "message" | "activity" | "proposed-plan";
export type TimelineSourceRowKind = "message" | "work" | "proposed-plan";

export interface TimelineSourceReference {
  readonly kind: TimelineSourceKind;
  readonly id: string;
  readonly createdAt: string;
  readonly sourceIndex: number;
  readonly turnId?: string | null;
  readonly sequence?: number;
}

export interface TimelineSourceRow {
  readonly id: string;
  readonly kind: TimelineSourceRowKind;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contentVersion: string;
  readonly startSourceIndex: number;
  readonly endSourceIndexExclusive: number;
  readonly turnId?: string | null;
  readonly sourceRefs: readonly TimelineSourceReference[];
}

export interface TimelineRowsSnapshot {
  readonly threadId: ThreadId;
  readonly revision: string;
  readonly updatedAt: string;
  readonly totalRows: number;
  readonly rows: readonly TimelineSourceRow[];
  readonly messages: readonly OrchestrationMessage[];
  readonly activities: readonly OrchestrationThreadActivity[];
  readonly proposedPlans: readonly OrchestrationProposedPlan[];
}

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
  readonly rows: readonly TimelineSourceRow[];
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
      readonly row: TimelineSourceRow;
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
  readonly entry: {
    readonly kind: TimelineSourceKind;
    readonly id: string;
    readonly createdAt: string;
    readonly turnId?: string | null;
    readonly sequence?: number;
  };
  readonly message?: OrchestrationMessage;
  readonly activity?: OrchestrationThreadActivity;
  readonly proposedPlan?: OrchestrationProposedPlan;
}

interface PrimeLiveTimelineRowOptions {
  readonly flush?: "frame" | "sync";
}

interface RemoveLiveTimelineRowInput {
  readonly threadId: ThreadId;
  readonly kind: TimelineSourceKind;
  readonly id: string;
}

interface RemoveLiveTimelineRowOptions {
  readonly flush?: "frame" | "sync";
}

function mergeQueuedLiveTimelineRowPatch(
  pending: PrimeLiveTimelineRowInput,
  input: PrimeLiveTimelineRowInput,
): PrimeLiveTimelineRowInput {
  const connectionUrl = resolveConnectionForThreadId(input.threadId);
  const message =
    pending.message && input.message
      ? chooseFreshestMessage(pending.message, input.message, connectionUrl)
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
  readonly rowsById: Record<string, TimelineSourceRow>;
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
  readonly primeSnapshot: (snapshot: TimelineRowsSnapshot) => void;
  readonly patchRow: (threadId: ThreadId, row: TimelineSourceRow) => void;
  readonly setActiveWindow: (threadId: ThreadId, window: TimelineRowsActiveWindow) => void;
  readonly noteRowHeightWrite: () => void;
  readonly clearThread: (threadId: ThreadId) => void;
  readonly reset: () => void;
}

const rowHeightCache = new LRUCache<number>(
  MAX_ROW_HEIGHT_CACHE_ENTRIES,
  MAX_ROW_HEIGHT_CACHE_ENTRIES * 24,
);
const inFlightThreadTimelineHydrationByThreadId = new Map<
  ThreadId,
  Promise<TimelineRowsSnapshot>
>();
type OpenPrefetchRecord = {
  readonly promise: Promise<void>;
  immediate: boolean;
  promoteToImmediate: () => void;
};
const inFlightThreadTimelineOpenPrefetchByThreadId = new Map<ThreadId, OpenPrefetchRecord>();
const backgroundThreadTimelinePrefetchRetryAfterByThreadId = new Map<ThreadId, number>();
type ThreadReadModelObserver = (thread: OrchestrationThread) => void;
let threadReadModelObserver: ThreadReadModelObserver | null = null;

/**
 * Registers a sink that receives every freshly fetched thread read model so a
 * single `getThread` round-trip can hydrate both the timeline and the app-level
 * thread caches. Used to unify the duplicate `getThread` RPCs that previously
 * fired when opening a thread (one for the timeline, one for store hydration).
 */
export function setThreadReadModelObserver(observer: ThreadReadModelObserver | null): void {
  threadReadModelObserver = observer;
}

function notifyThreadReadModelFetched(thread: OrchestrationThread): void {
  if (!threadReadModelObserver) {
    return;
  }
  try {
    threadReadModelObserver(thread);
  } catch {
    // Observer side effects (cache priming) must never break timeline hydration.
  }
}

const projectionCacheByThreadId = new Map<string, TimelineRowsProjectionCacheEntry>();
const liveTimelineRowPatchQueue = new Map<string, PrimeLiveTimelineRowInput>();
const liveTimelineRowRemovalQueue = new Map<string, RemoveLiveTimelineRowInput>();
const liveTimelineRowSyncPatchQueue = new Map<string, PrimeLiveTimelineRowInput>();
const liveTimelineRowSyncRemovalQueue = new Map<string, RemoveLiveTimelineRowInput>();
let liveTimelineRowSyncBatchDepth = 0;
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
  liveTimelineRowSyncPatchQueue.clear();
  liveTimelineRowSyncRemovalQueue.clear();
  liveTimelineRowSyncBatchDepth = 0;
}

function liveTimelinePatchQueueKey(input: PrimeLiveTimelineRowInput): string {
  return `${input.threadId}:${input.entry.kind}:${String(input.entry.id)}`;
}

function liveTimelineRemovalQueueKey(input: RemoveLiveTimelineRowInput): string {
  return `${input.threadId}:${input.kind}:${input.id}`;
}

function enqueueLiveTimelineRowPatch(
  patchQueue: Map<string, PrimeLiveTimelineRowInput>,
  removalQueue: Map<string, RemoveLiveTimelineRowInput>,
  input: PrimeLiveTimelineRowInput,
): void {
  const queueKey = liveTimelinePatchQueueKey(input);
  removalQueue.delete(queueKey);
  const pending = patchQueue.get(queueKey);
  patchQueue.set(queueKey, pending ? mergeQueuedLiveTimelineRowPatch(pending, input) : input);
}

function enqueueLiveTimelineRowRemoval(
  patchQueue: Map<string, PrimeLiveTimelineRowInput>,
  removalQueue: Map<string, RemoveLiveTimelineRowInput>,
  input: RemoveLiveTimelineRowInput,
): void {
  const queueKey = liveTimelineRemovalQueueKey(input);
  patchQueue.delete(queueKey);
  removalQueue.set(queueKey, input);
}

function flushLiveTimelineRowSyncBatch(): void {
  if (liveTimelineRowSyncPatchQueue.size === 0 && liveTimelineRowSyncRemovalQueue.size === 0) {
    return;
  }
  const removals = [...liveTimelineRowSyncRemovalQueue.values()];
  const patches = [...liveTimelineRowSyncPatchQueue.values()];
  liveTimelineRowSyncRemovalQueue.clear();
  liveTimelineRowSyncPatchQueue.clear();
  applyLiveTimelineRowQueue({ removals, patches });
}

export function batchLiveTimelineRowUpdates<TResult>(callback: () => TResult): TResult {
  liveTimelineRowSyncBatchDepth += 1;
  try {
    return callback();
  } finally {
    liveTimelineRowSyncBatchDepth -= 1;
    if (liveTimelineRowSyncBatchDepth === 0) {
      flushLiveTimelineRowSyncBatch();
    }
  }
}

function cancelRowHeightRevisionFrame(): void {
  if (rowHeightRevisionFrame === null) {
    return;
  }
  cancelScheduledAnimationFrame(rowHeightRevisionFrame);
  rowHeightRevisionFrame = null;
}

function createThreadTimelineHydrationTimeout(threadId: ThreadId): Promise<never> {
  return new Promise((_, reject) => {
    globalThis.setTimeout(() => {
      reject(
        new Error(
          `Timed out hydrating timeline rows for thread ${String(
            threadId,
          )} after ${String(THREAD_TIMELINE_HYDRATION_TIMEOUT_MS)}ms.`,
        ),
      );
    }, THREAD_TIMELINE_HYDRATION_TIMEOUT_MS);
  });
}

function rowKey(threadId: ThreadId, rowId: string): string {
  return `${threadId}:${rowId}`;
}

function rowKindForSourceKind(kind: TimelineSourceKind): TimelineSourceRow["kind"] {
  if (kind === "message") return "message";
  if (kind === "activity") return "work";
  return "proposed-plan";
}

function rowIdForSource(kind: TimelineSourceKind, id: string): string {
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

function normalizeTimelineMessageAttachments(
  attachments: OrchestrationMessage["attachments"],
  connectionUrl?: string,
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
      previewUrl: resolveAttachmentPreviewUrl(String(attachment.id), connectionUrl),
    };
  }) as OrchestrationMessage["attachments"];
}

function mergeTimelineMessageAttachments(
  existing: OrchestrationMessage["attachments"],
  incoming: OrchestrationMessage["attachments"],
  connectionUrl?: string,
): OrchestrationMessage["attachments"] {
  const normalizedIncoming = normalizeTimelineMessageAttachments(incoming, connectionUrl);
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

function normalizeTimelineMessage(
  message: OrchestrationMessage,
  connectionUrl?: string,
): OrchestrationMessage {
  const attachments = normalizeTimelineMessageAttachments(message.attachments, connectionUrl);
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
  connectionUrl?: string,
): OrchestrationMessage {
  if (!existing) {
    return normalizeTimelineMessage(incoming, connectionUrl);
  }
  const normalizedIncoming = normalizeTimelineMessage(incoming, connectionUrl);
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
      connectionUrl,
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
      connectionUrl,
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
      connectionUrl,
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
    connectionUrl,
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
  left: TimelineSourceRow,
  right: TimelineSourceRow,
): number {
  const leftSource = left.sourceRefs[0];
  const rightSource = right.sourceRefs[0];
  if (leftSource && rightSource) {
    const sourceOrder = compareOrchestrationTimelineSources(
      {
        kind: leftSource.kind,
        id: leftSource.id,
        createdAt: leftSource.createdAt,
        sequence: leftSource.sequence ?? null,
      },
      {
        kind: rightSource.kind,
        id: rightSource.id,
        createdAt: rightSource.createdAt,
        sequence: rightSource.sequence ?? null,
      },
    );
    if (sourceOrder !== 0) {
      return sourceOrder;
    }
  }
  return (
    compareLiveTimelineRowSourceSequence(left, right) ||
    left.startSourceIndex - right.startSourceIndex ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function timelineRowSourceRefsEqual(
  left: readonly TimelineSourceRow["sourceRefs"][number][],
  right: readonly TimelineSourceRow["sourceRefs"][number][],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftRef = left[index];
    const rightRef = right[index];
    if (
      !leftRef ||
      !rightRef ||
      leftRef.kind !== rightRef.kind ||
      leftRef.id !== rightRef.id ||
      leftRef.createdAt !== rightRef.createdAt ||
      leftRef.sourceIndex !== rightRef.sourceIndex ||
      leftRef.turnId !== rightRef.turnId ||
      leftRef.sequence !== rightRef.sequence
    ) {
      return false;
    }
  }
  return true;
}

function timelineRowsEqual(left: TimelineSourceRow | undefined, right: TimelineSourceRow): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.kind === right.kind &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.contentVersion === right.contentVersion &&
    left.startSourceIndex === right.startSourceIndex &&
    left.endSourceIndexExclusive === right.endSourceIndexExclusive &&
    left.turnId === right.turnId &&
    timelineRowSourceRefsEqual(left.sourceRefs, right.sourceRefs)
  );
}

function compareLiveTimelineRowSourceSequence(
  left: TimelineSourceRow,
  right: TimelineSourceRow,
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

function isLiveTimelineRow(row: TimelineSourceRow): boolean {
  return row.contentVersion.startsWith("live:");
}

function timelineRowFirstSequence(row: TimelineSourceRow): number | undefined {
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
  rowsById: Readonly<Record<string, TimelineSourceRow>>,
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
  snapshot: TimelineRowsSnapshot,
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
  const connectionUrl = resolveConnectionForThreadId(snapshot.threadId);
  for (const message of snapshot.messages) {
    messagesById[String(message.id)] = chooseFreshestMessage(
      messagesById[String(message.id)],
      message,
      connectionUrl,
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
      const previousRow = state.rowsById[rowKey(threadId, row.id)];
      if (timelineRowsEqual(previousRow, row)) {
        return state;
      }
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
    set((state) => {
      if (timelineRowsActiveWindowEquals(state.activeWindowByThreadId[threadId], window)) {
        return state;
      }
      return {
        ...state,
        activeWindowByThreadId: {
          ...state.activeWindowByThreadId,
          [threadId]: window,
        },
      };
    }),
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
    inFlightThreadTimelineHydrationByThreadId.clear();
    inFlightThreadTimelineOpenPrefetchByThreadId.clear();
    backgroundThreadTimelinePrefetchRetryAfterByThreadId.clear();
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

type ThreadTimelineSource =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly turnId: string | null;
      readonly sequence?: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly textLength: number;
    }
  | {
      readonly kind: "activity";
      readonly id: string;
      readonly turnId: string | null;
      readonly sequence?: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly textLength: number;
    }
  | {
      readonly kind: "proposed-plan";
      readonly id: string;
      readonly turnId: string | null;
      readonly sequence?: number;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly textLength: number;
    };

function toThreadTimelineSources(thread: OrchestrationThread): ThreadTimelineSource[] {
  return [
    ...thread.messages.map(
      (message): ThreadTimelineSource => ({
        kind: "message",
        id: String(message.id),
        turnId: message.turnId,
        ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        textLength: message.text.length,
      }),
    ),
    ...thread.activities.map(
      (activity): ThreadTimelineSource => ({
        kind: "activity",
        id: String(activity.id),
        turnId: activity.turnId,
        ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
        createdAt: activity.createdAt,
        updatedAt: activity.createdAt,
        textLength: activity.summary.length + JSON.stringify(activity.payload ?? null).length,
      }),
    ),
    ...thread.proposedPlans.map(
      (proposedPlan): ThreadTimelineSource => ({
        kind: "proposed-plan",
        id: String(proposedPlan.id),
        turnId: proposedPlan.turnId,
        createdAt: proposedPlan.createdAt,
        updatedAt: proposedPlan.updatedAt,
        textLength: proposedPlan.planMarkdown.length,
      }),
    ),
  ].toSorted(compareOrchestrationTimelineSources);
}

function contentVersionForSource(source: ThreadTimelineSource): string {
  return ["source", source.kind, source.id, source.updatedAt, source.textLength].join(":");
}

function buildTimelineRowsSnapshotFromThread(thread: OrchestrationThread): TimelineRowsSnapshot {
  const connectionUrl = resolveConnectionForThreadId(thread.id);
  const sources = toThreadTimelineSources(thread);
  const rows = sources.map(
    (source, sourceIndex): TimelineSourceRow => ({
      id: rowIdForSource(source.kind, source.id),
      kind: rowKindForSourceKind(source.kind),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      contentVersion: contentVersionForSource(source),
      startSourceIndex: sourceIndex,
      endSourceIndexExclusive: sourceIndex + 1,
      ...(source.turnId !== null ? { turnId: source.turnId } : {}),
      sourceRefs: [
        {
          kind: source.kind,
          id: source.id,
          createdAt: source.createdAt,
          sourceIndex,
          ...(source.turnId !== null ? { turnId: source.turnId } : {}),
          ...(source.sequence !== undefined ? { sequence: source.sequence } : {}),
        },
      ],
    }),
  );
  return {
    threadId: thread.id,
    revision: timelineRowsMetadataFromReadModelThread(thread).revision,
    updatedAt: thread.updatedAt,
    totalRows: rows.length,
    rows,
    messages: thread.messages.map((message) => normalizeTimelineMessage(message, connectionUrl)),
    activities: thread.activities,
    proposedPlans: thread.proposedPlans,
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

function timelineRowsActiveWindowEquals(
  left: TimelineRowsActiveWindow | undefined,
  right: TimelineRowsActiveWindow,
): boolean {
  return (
    left !== undefined &&
    left.startRowIndex === right.startRowIndex &&
    left.endRowIndexExclusive === right.endRowIndexExclusive &&
    left.overscanStartRowIndex === right.overscanStartRowIndex &&
    left.overscanEndRowIndexExclusive === right.overscanEndRowIndexExclusive &&
    left.revision === right.revision
  );
}

export type PrimeThreadTimelineRowsMetadataOptions = {
  /**
   * When true and the thread already holds live rows, skip replacing them with
   * the (possibly stale) read-model snapshot. While a turn is actively
   * streaming, the server read-model projection lags behind the live event
   * stream; reconciling that stale snapshot against newer live rows can briefly
   * drop or revert freshly streamed content (the "come and go" flicker). Letting
   * the live patch queue stay authoritative until the turn settles avoids that.
   */
  readonly preferExistingLiveRows?: boolean;
};

function threadHasLoadedTimelineRows(threadId: ThreadId): boolean {
  return (useTimelineModelStore.getState().rowIdsByThreadId[threadId]?.length ?? 0) > 0;
}

export function primeThreadTimelineRowsMetadataFromReadModelThread(
  thread: OrchestrationReadModel["threads"][number],
  options?: PrimeThreadTimelineRowsMetadataOptions,
): void {
  if (options?.preferExistingLiveRows && threadHasLoadedTimelineRows(thread.id)) {
    return;
  }
  if (
    thread.messages.length > 0 ||
    thread.activities.length > 0 ||
    thread.proposedPlans.length > 0
  ) {
    useTimelineModelStore.getState().primeSnapshot(buildTimelineRowsSnapshotFromThread(thread));
    return;
  }
  useTimelineModelStore.getState().primeMetadata(timelineRowsMetadataFromReadModelThread(thread));
}

export type PrimeThreadTimelineRowsMetadataThreadsOptions = {
  /**
   * Threads that are actively streaming a turn. Snapshot reconciliation for
   * these threads is skipped while they already hold live rows, keeping the
   * live event stream authoritative (see {@link PrimeThreadTimelineRowsMetadataOptions}).
   */
  readonly preferExistingLiveRowsThreadIds?: ReadonlySet<ThreadId>;
};

export function primeThreadTimelineRowsMetadataFromReadModelThreads(
  threads: ReadonlyArray<OrchestrationReadModel["threads"][number]>,
  options?: PrimeThreadTimelineRowsMetadataThreadsOptions,
): void {
  if (threads.length === 0) {
    return;
  }

  const preferExistingLiveRowsThreadIds = options?.preferExistingLiveRowsThreadIds;
  const hydratedThreads: OrchestrationThread[] = [];
  const metadataOnlyThreads: OrchestrationThread[] = [];
  for (const thread of threads) {
    if (preferExistingLiveRowsThreadIds?.has(thread.id) && threadHasLoadedTimelineRows(thread.id)) {
      continue;
    }
    if (
      thread.messages.length > 0 ||
      thread.activities.length > 0 ||
      thread.proposedPlans.length > 0
    ) {
      hydratedThreads.push(thread);
    } else {
      metadataOnlyThreads.push(thread);
    }
  }

  for (const thread of hydratedThreads) {
    useTimelineModelStore.getState().primeSnapshot(buildTimelineRowsSnapshotFromThread(thread));
  }
  if (metadataOnlyThreads.length === 0) {
    return;
  }

  useTimelineModelStore.setState((state) => {
    let metadataByThreadId = state.metadataByThreadId;
    let revisionByThreadId = state.revisionByThreadId;
    let changed = false;

    for (const thread of metadataOnlyThreads) {
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

export async function fetchThreadTimelineRowsHydration(
  threadId: ThreadId,
): Promise<TimelineRowsSnapshot> {
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

  const existing = inFlightThreadTimelineHydrationByThreadId.get(threadId);
  if (existing) {
    return existing;
  }

  useTimelineModelStore.getState().beginFetches(threadId, 1);
  const rpcPromise = ensureNativeApi().orchestration.getThread({ threadId });
  const hydratedSnapshotPromise = rpcPromise.then((thread) => {
    notifyThreadReadModelFetched(thread);
    const snapshot = buildTimelineRowsSnapshotFromThread(thread);
    useTimelineModelStore.getState().primeSnapshot(snapshot);
    return snapshot;
  });
  void hydratedSnapshotPromise.catch(() => undefined);
  const promise = Promise.race([
    hydratedSnapshotPromise,
    createThreadTimelineHydrationTimeout(threadId),
  ]).finally(() => {
    inFlightThreadTimelineHydrationByThreadId.delete(threadId);
    useTimelineModelStore.getState().finishFetches(threadId, 1);
  });
  inFlightThreadTimelineHydrationByThreadId.set(threadId, promise);
  return promise;
}

export function hydrateThreadTimelineRowsInBackground(threadId: ThreadId): void {
  const existing = inFlightThreadTimelineHydrationByThreadId.get(threadId);
  if (existing) {
    void existing.catch(() => undefined);
    return;
  }

  useTimelineModelStore.getState().beginFetches(threadId, 1);
  let promise: Promise<TimelineRowsSnapshot>;
  try {
    promise = ensureNativeApi()
      .orchestration.getThread({ threadId })
      .then((thread) => {
        notifyThreadReadModelFetched(thread);
        const snapshot = buildTimelineRowsSnapshotFromThread(thread);
        useTimelineModelStore.getState().primeSnapshot(snapshot);
        return snapshot;
      })
      .finally(() => {
        inFlightThreadTimelineHydrationByThreadId.delete(threadId);
        useTimelineModelStore.getState().finishFetches(threadId, 1);
      });
  } catch (error) {
    useTimelineModelStore.getState().finishFetches(threadId, 1);
    void error;
    return;
  }
  inFlightThreadTimelineHydrationByThreadId.set(threadId, promise);
  void promise.catch(() => undefined);
}

export interface ThreadTimelineRowsOpenPrefetchHandle {
  readonly done: Promise<void>;
  readonly stop: () => void;
}

export async function prefetchThreadTimelineRows(input: {
  readonly threadId: ThreadId;
}): Promise<void> {
  if (isThreadTimelineRowsFullyHydrated(input.threadId)) {
    return;
  }
  await fetchThreadTimelineRowsHydration(input.threadId);
}

export function startThreadTimelineRowsOpenPrefetch(input: {
  readonly threadId: ThreadId;
  readonly priority?: "background" | "immediate";
}): ThreadTimelineRowsOpenPrefetchHandle {
  const immediate = input.priority === "immediate";
  let canceled = false;

  if (isThreadTimelineRowsFullyHydrated(input.threadId)) {
    backgroundThreadTimelinePrefetchRetryAfterByThreadId.delete(input.threadId);
    return {
      done: Promise.resolve(),
      stop: () => {
        canceled = true;
      },
    };
  }

  const existing = inFlightThreadTimelineOpenPrefetchByThreadId.get(input.threadId);
  if (existing) {
    // A background prefetch that is still sitting in its startup delay must not
    // block an immediate open behind that delay. Promote it so the underlying
    // fetch fires right away instead of waiting out the background timer.
    if (immediate && !existing.immediate) {
      existing.immediate = true;
      existing.promoteToImmediate();
    }
    return {
      done: immediate ? existing.promise : existing.promise.catch(() => undefined),
      stop: () => {
        canceled = true;
      },
    };
  }

  if (!immediate) {
    const retryAfter =
      backgroundThreadTimelinePrefetchRetryAfterByThreadId.get(input.threadId) ?? 0;
    if (retryAfter > Date.now()) {
      return {
        done: Promise.resolve(),
        stop: () => {
          canceled = true;
        },
      };
    }
  }

  let promoteBackgroundDelay: (() => void) | null = null;
  const backgroundDelay = immediate
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const timerId = globalThis.setTimeout(resolve, BACKGROUND_TIMELINE_ROWS_PREFETCH_DELAY_MS);
        promoteBackgroundDelay = () => {
          globalThis.clearTimeout(timerId);
          resolve();
        };
      });

  const promise = (async () => {
    await backgroundDelay;
    if (canceled) {
      return;
    }
    await prefetchThreadTimelineRows({ threadId: input.threadId });
    if (canceled) {
      return;
    }
    backgroundThreadTimelinePrefetchRetryAfterByThreadId.delete(input.threadId);
  })()
    .catch((error) => {
      backgroundThreadTimelinePrefetchRetryAfterByThreadId.set(
        input.threadId,
        Date.now() + BACKGROUND_TIMELINE_ROWS_PREFETCH_FAILURE_BACKOFF_MS,
      );
      throw error;
    })
    .finally(() => {
      if (inFlightThreadTimelineOpenPrefetchByThreadId.get(input.threadId) === record) {
        inFlightThreadTimelineOpenPrefetchByThreadId.delete(input.threadId);
      }
    });

  const record: OpenPrefetchRecord = {
    promise,
    immediate,
    promoteToImmediate: () => {
      promoteBackgroundDelay?.();
      promoteBackgroundDelay = null;
    },
  };

  inFlightThreadTimelineOpenPrefetchByThreadId.set(input.threadId, record);

  return {
    done: immediate ? promise : promise.catch(() => undefined),
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

  const rows: TimelineSourceRow[] = [];
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
  const rowBySourceIndex = new Map<number, TimelineSourceRow>();
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
  const queueKey = liveTimelinePatchQueueKey(input);
  if (options.flush === "sync") {
    liveTimelineRowPatchQueue.delete(queueKey);
    liveTimelineRowRemovalQueue.delete(queueKey);
    if (liveTimelineRowSyncBatchDepth > 0) {
      enqueueLiveTimelineRowPatch(
        liveTimelineRowSyncPatchQueue,
        liveTimelineRowSyncRemovalQueue,
        input,
      );
      return;
    }
    applyLiveTimelineRowPatches([input]);
    return;
  }
  enqueueLiveTimelineRowPatch(liveTimelineRowPatchQueue, liveTimelineRowRemovalQueue, input);
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
    const queueKey = liveTimelineRemovalQueueKey(input);
    liveTimelineRowPatchQueue.delete(queueKey);
  }
  if (options.flush === "sync") {
    if (liveTimelineRowSyncBatchDepth > 0) {
      for (const input of inputs) {
        enqueueLiveTimelineRowRemoval(
          liveTimelineRowSyncPatchQueue,
          liveTimelineRowSyncRemovalQueue,
          input,
        );
      }
      return;
    }
    applyLiveTimelineRowRemovals(inputs);
    return;
  }
  for (const input of inputs) {
    enqueueLiveTimelineRowRemoval(liveTimelineRowPatchQueue, liveTimelineRowRemovalQueue, input);
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
  const previousRowIdSetsByThreadId = new Map<ThreadId, ReadonlySet<string>>();

  for (const input of inputs) {
    const rowId = rowIdForSource(input.kind, input.id);
    const rowStoreKey = rowKey(input.threadId, rowId);
    const previousRowIds = rowIdsByThreadId[input.threadId] ?? [];
    let previousRowIdSet = previousRowIdSetsByThreadId.get(input.threadId);
    if (!previousRowIdSet) {
      previousRowIdSet = new Set(previousRowIds);
      previousRowIdSetsByThreadId.set(input.threadId, previousRowIdSet);
    }
    if (!previousRowIdSet.has(rowId) && rowsById[rowStoreKey] === undefined) {
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
  readonly rowsById: Readonly<Record<string, TimelineSourceRow>>;
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
    const entry = input.entry;
    const entryKind = entry.kind;
    const entryId = String(entry.id);
    const entryTurnId = entry.turnId;
    const previousMetadata = metadataByThreadId[input.threadId];
    const rowId = rowIdForSource(entryKind, entryId);
    const previousRow = rowsById[rowKey(input.threadId, rowId)];
    const threadRowIds = rowIdsByThreadId[input.threadId] ?? [];
    const threadRowIdSet = new Set(threadRowIds);
    const sourceIndex =
      previousRow?.startSourceIndex ??
      resolveNextLiveTimelineSourceIndex({
        metadataByThreadId,
        nextSourceIndexByThreadId,
        rowIdsByThreadId,
        rowsById,
        threadId: input.threadId,
      });
    const row: TimelineSourceRow = {
      id: rowId,
      kind: rowKindForSourceKind(entryKind),
      createdAt: entry.createdAt,
      updatedAt: input.updatedAt,
      contentVersion: [
        "live",
        entryKind,
        entryId,
        input.updatedAt,
        input.message?.text.length ??
          input.activity?.summary.length ??
          input.proposedPlan?.planMarkdown.length ??
          0,
      ].join(":"),
      startSourceIndex: sourceIndex,
      endSourceIndexExclusive: sourceIndex + 1,
      ...(entryTurnId !== undefined ? { turnId: entryTurnId } : {}),
      sourceRefs: [
        {
          kind: entryKind,
          id: entryId,
          createdAt: entry.createdAt,
          sourceIndex,
          ...(entryTurnId !== undefined ? { turnId: entryTurnId } : {}),
          ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
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

    const isExistingRow = threadRowIdSet.has(rowId);
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
      const connectionUrl = resolveConnectionForThreadId(input.threadId);
      messagesById[String(input.message.id)] = chooseFreshestMessage(
        messagesById[String(input.message.id)],
        input.message,
        connectionUrl,
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

export function readTimelineRow(threadId: ThreadId, rowId: string): TimelineSourceRow | null {
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
