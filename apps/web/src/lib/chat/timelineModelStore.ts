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
const MAX_ROW_HEIGHT_CACHE_ENTRIES = clampCacheEntryCount(32_000, {
  moderateCapEntries: 16_000,
  constrainedCapEntries: 8_000,
});

export interface TimelineRowsMetadata {
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
let liveTimelineRowPatchFrame: number | null = null;

function cancelLiveTimelineRowPatchFrame(): void {
  if (liveTimelineRowPatchFrame !== null) {
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(liveTimelineRowPatchFrame);
    }
    globalThis.clearTimeout(liveTimelineRowPatchFrame);
    liveTimelineRowPatchFrame = null;
  }
  liveTimelineRowPatchQueue.clear();
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

function chooseFreshestMessage(
  existing: OrchestrationMessage | undefined,
  incoming: OrchestrationMessage,
): OrchestrationMessage {
  if (!existing) {
    return incoming;
  }
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
  return incoming;
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

  const loadedAt = Date.now();

  return {
    ...state,
    metadataByThreadId: {
      ...state.metadataByThreadId,
      [snapshot.threadId]: {
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
        revision: snapshot.revision,
        totalRows,
        loadedAt,
      },
    },
    rowIdsByThreadId: {
      ...state.rowIdsByThreadId,
      [snapshot.threadId]: sortedRowIds,
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
    set((state) => ({
      ...state,
      rowsById: {
        ...state.rowsById,
        [rowKey(threadId, row.id)]: row,
      },
      rowIdsByThreadId: {
        ...state.rowIdsByThreadId,
        [threadId]: state.rowIdsByThreadId[threadId]?.includes(row.id)
          ? state.rowIdsByThreadId[threadId]
          : [...(state.rowIdsByThreadId[threadId] ?? []), row.id],
      },
      revisionByThreadId: bumpThreadRevision(state, threadId),
      revision: state.revision + 1,
    })),
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
    set(createInitialTimelineModelState());
  },
}));

function timelineRowsMetadataFromReadModelThread(
  thread: OrchestrationReadModel["threads"][number],
): TimelineRowsMetadata {
  const totalRows = thread.messages.length + thread.activities.length + thread.proposedPlans.length;
  return {
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
  const promise = ensureNativeApi()
    .orchestration.getThreadTimelineRowsSnapshot({ threadId })
    .then((snapshot) => {
      useTimelineModelStore.getState().primeSnapshot(snapshot);
      return snapshot;
    })
    .finally(() => {
      inFlightRowsSnapshotByThreadId.delete(threadId);
      useTimelineModelStore.getState().finishFetches(threadId, 1);
    });
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
    applyLiveTimelineRowPatches([input]);
    return;
  }
  liveTimelineRowPatchQueue.set(queueKey, input);
  if (liveTimelineRowPatchFrame !== null) {
    return;
  }
  const scheduleFrame =
    typeof globalThis.requestAnimationFrame === "function"
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) =>
          globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
  liveTimelineRowPatchFrame = scheduleFrame(() => {
    liveTimelineRowPatchFrame = null;
    const patches = [...liveTimelineRowPatchQueue.values()];
    liveTimelineRowPatchQueue.clear();
    applyLiveTimelineRowPatches(patches);
  });
}

export function removeLiveTimelineRow(input: {
  readonly threadId: ThreadId;
  readonly kind: OrchestrationThreadTimelineEntryReference["kind"];
  readonly id: string;
}): void {
  const rowId = rowIdForSource(input.kind, input.id);
  const rowStoreKey = rowKey(input.threadId, rowId);
  const queueKey = `${input.threadId}:${input.kind}:${input.id}`;
  liveTimelineRowPatchQueue.delete(queueKey);
  useTimelineModelStore.setState((state) => {
    const previousRowIds = state.rowIdsByThreadId[input.threadId] ?? [];
    if (!previousRowIds.includes(rowId) && state.rowsById[rowStoreKey] === undefined) {
      return state;
    }

    const nextRowIds = previousRowIds.filter((existingRowId) => existingRowId !== rowId);
    const { [rowStoreKey]: _removedRow, ...nextRowsById } = state.rowsById;
    const previousMetadata = state.metadataByThreadId[input.threadId];
    const nextMetadata = previousMetadata
      ? {
          ...previousMetadata,
          totalRows: nextRowIds.length,
          tailStartRowIndex: Math.max(0, nextRowIds.length - DEFAULT_TIMELINE_TAIL_WINDOW_ROWS),
          updatedAt: new Date().toISOString(),
        }
      : undefined;

    const nextMessagesById =
      input.kind === "message"
        ? (({ [input.id]: _removedMessage, ...remaining }) => remaining)(state.messagesById)
        : state.messagesById;
    const nextActivitiesById =
      input.kind === "activity"
        ? (({ [input.id]: _removedActivity, ...remaining }) => remaining)(state.activitiesById)
        : state.activitiesById;
    const nextProposedPlansById =
      input.kind === "proposed-plan"
        ? (({ [input.id]: _removedPlan, ...remaining }) => remaining)(state.proposedPlansById)
        : state.proposedPlansById;

    return {
      ...state,
      metadataByThreadId: nextMetadata
        ? { ...state.metadataByThreadId, [input.threadId]: nextMetadata }
        : state.metadataByThreadId,
      rowIdsByThreadId: { ...state.rowIdsByThreadId, [input.threadId]: nextRowIds },
      rowsById: nextRowsById,
      messagesById: nextMessagesById,
      activitiesById: nextActivitiesById,
      proposedPlansById: nextProposedPlansById,
      revisionByThreadId: bumpThreadRevision(state, input.threadId),
      revision: state.revision + 1,
    };
  });
}

function applyLiveTimelineRowPatches(patches: readonly PrimeLiveTimelineRowInput[]): void {
  if (patches.length === 0) {
    return;
  }
  useTimelineModelStore.setState((state) =>
    patches.reduce<TimelineModelState>(applyLiveTimelineRowPatchToState, state),
  );
}

function applyLiveTimelineRowPatchToState(
  state: TimelineModelState,
  input: PrimeLiveTimelineRowInput,
): TimelineModelState {
  const previousMetadata = state.metadataByThreadId[input.threadId];
  const rowId = rowIdForSource(input.entry.kind, String(input.entry.id));
  const previousRow = state.rowsById[rowKey(input.threadId, rowId)];
  const threadRowIds = state.rowIdsByThreadId[input.threadId] ?? [];
  let nextSourceIndex = previousMetadata?.totalRows ?? 0;
  for (const existingRowId of threadRowIds) {
    const existingRow = state.rowsById[rowKey(input.threadId, existingRowId)];
    if (!existingRow) {
      continue;
    }
    nextSourceIndex = Math.max(nextSourceIndex, existingRow.endSourceIndexExclusive);
  }
  const sourceIndex = previousRow?.startSourceIndex ?? nextSourceIndex;
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
  const nextThreadRowIds = threadRowIds.includes(rowId) ? threadRowIds : [...threadRowIds, rowId];
  const nextTotalRows = Math.max(
    previousMetadata?.totalRows ?? 0,
    row.endSourceIndexExclusive,
    nextThreadRowIds.length,
  );
  const previousCompleteSnapshot = state.completeSnapshotByThreadId[input.threadId];

  return {
    ...state,
    metadataByThreadId: {
      ...state.metadataByThreadId,
      [input.threadId]: {
        threadId: input.threadId,
        revision: previousMetadata?.revision ?? `live:${input.threadId}`,
        updatedAt: input.updatedAt,
        totalRows: nextTotalRows,
        tailStartRowIndex: Math.max(0, nextTotalRows - DEFAULT_TIMELINE_TAIL_WINDOW_ROWS),
      },
    },
    completeSnapshotByThreadId: previousCompleteSnapshot
      ? {
          ...state.completeSnapshotByThreadId,
          [input.threadId]: {
            ...previousCompleteSnapshot,
            totalRows: Math.max(previousCompleteSnapshot.totalRows, nextTotalRows),
          },
        }
      : state.completeSnapshotByThreadId,
    rowIdsByThreadId: {
      ...state.rowIdsByThreadId,
      [input.threadId]: nextThreadRowIds,
    },
    rowsById: {
      ...state.rowsById,
      [rowKey(input.threadId, row.id)]: row,
    },
    messagesById: input.message
      ? {
          ...state.messagesById,
          [String(input.message.id)]: chooseFreshestMessage(
            state.messagesById[String(input.message.id)],
            input.message,
          ),
        }
      : state.messagesById,
    activitiesById: input.activity
      ? { ...state.activitiesById, [String(input.activity.id)]: input.activity }
      : state.activitiesById,
    proposedPlansById: input.proposedPlan
      ? {
          ...state.proposedPlansById,
          [String(input.proposedPlan.id)]: chooseFreshestProposedPlan(
            state.proposedPlansById[String(input.proposedPlan.id)],
            input.proposedPlan,
          ),
        }
      : state.proposedPlansById,
    revisionByThreadId: bumpThreadRevision(state, input.threadId),
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
  rowHeightCache.set(rowId, height, 24);
  useTimelineModelStore.getState().noteRowHeightWrite();
}

export function readTimelineModelRowHeight(rowId: string): number | null {
  return rowHeightCache.get(rowId);
}
