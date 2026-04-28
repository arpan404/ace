import type { ThreadId } from "@ace/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { normalizePaneRatios } from "./lib/paneRatios";
import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

export interface ChatThreadBoardPaneState {
  connectionUrl: string | null;
  id: string;
  threadId: ThreadId;
}

export interface ChatThreadBoardRowState {
  id: string;
  paneIds: string[];
  paneRatios: number[];
}

export interface ChatThreadBoardSplitState {
  activePaneId: string | null;
  archivedAt: string | null;
  createdAt: string;
  id: string;
  paneRatios: number[];
  panes: ChatThreadBoardPaneState[];
  rows: ChatThreadBoardRowState[];
  title: string;
  updatedAt: string;
}

interface PersistedChatThreadBoardState {
  activeSplitId: string | null;
  activePaneId: string | null;
  paneRatios: number[];
  panes: ChatThreadBoardPaneState[];
  rows: ChatThreadBoardRowState[];
  splits: ChatThreadBoardSplitState[];
}

interface ChatThreadBoardStoreState extends PersistedChatThreadBoardState {
  archiveSplit: (splitId: string) => void;
  closePane: (paneId: string) => void;
  createSplit: (input: {
    activeThread: { connectionUrl?: string | null; threadId: ThreadId };
    threads: ReadonlyArray<{ connectionUrl?: string | null; threadId: ThreadId }>;
    title?: string;
  }) => string | null;
  deleteSplit: (splitId: string) => void;
  openThreadInBoard: (input: {
    connectionUrl?: string | null;
    direction?: "down" | "right";
    sourcePaneId?: string | null;
    threadId: ThreadId;
  }) => string | null;
  openThreadsInBoard: (
    inputs: ReadonlyArray<{
      connectionUrl?: string | null;
      threadId: ThreadId;
    }>,
    options?: { sourcePaneId?: string | null },
  ) => string | null;
  renameSplit: (splitId: string, title: string) => void;
  restoreSplit: (splitId: string, activePaneId?: string | null) => string | null;
  setActivePane: (paneId: string | null) => void;
  setActiveSplit: (splitId: string | null) => void;
  setGridLayout: (input: { columns: number }) => void;
  setSplitGridLayout: (splitId: string, input: { columns: number }) => void;
  setPaneRatios: (rowId: string, ratios: readonly number[]) => void;
  setRowRatios: (ratios: readonly number[]) => void;
  syncRouteThread: (input: { connectionUrl?: string | null; threadId: ThreadId }) => string;
  syncRouteThreads: (input: {
    activeThread?: { connectionUrl?: string | null; threadId: ThreadId } | null;
    threads: ReadonlyArray<{ connectionUrl?: string | null; threadId: ThreadId }>;
  }) => string | null;
}

const STORAGE_KEY = "ace:chat-thread-board:v1";
const BOARD_MULTI_OPEN_COLUMNS = 2;

function createChatThreadBoardStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeConnectionUrl(connectionUrl: string | null | undefined): string | null {
  const normalized = connectionUrl?.trim();
  return normalized ? normalized : null;
}

function buildThreadKey(threadId: ThreadId, connectionUrl: string | null): string {
  return `${connectionUrl ?? "local"}:${threadId}`;
}

function createPane(input: {
  connectionUrl?: string | null;
  id?: string;
  threadId: ThreadId;
}): ChatThreadBoardPaneState {
  return {
    connectionUrl: normalizeConnectionUrl(input.connectionUrl),
    id: input.id ?? `pane-${randomUUID()}`,
    threadId: input.threadId,
  };
}

function createRow(
  paneIds: readonly string[],
  input?: { id?: string; paneRatios?: readonly number[] },
): ChatThreadBoardRowState {
  return {
    id: input?.id ?? `row-${randomUUID()}`,
    paneIds: [...paneIds],
    paneRatios: normalizePaneRatios(input?.paneRatios ?? [], paneIds.length),
  };
}

function createDefaultBoardState(): PersistedChatThreadBoardState {
  return {
    activeSplitId: null,
    activePaneId: null,
    paneRatios: [],
    panes: [],
    rows: [],
    splits: [],
  };
}

type BoardStateFields = Pick<
  PersistedChatThreadBoardState,
  "activePaneId" | "paneRatios" | "panes" | "rows"
>;

function createTimestamp(): string {
  return new Date().toISOString();
}

function createSplitTitle(index: number): string {
  return `Board ${index}`;
}

function normalizeBoardState(input: BoardStateFields): BoardStateFields {
  const paneById = new Map<string, ChatThreadBoardPaneState>();
  const seenThreadKeys = new Set<string>();
  for (const pane of input.panes) {
    if (!pane?.id) {
      continue;
    }
    const normalizedPane: ChatThreadBoardPaneState = {
      ...pane,
      connectionUrl: normalizeConnectionUrl(pane.connectionUrl),
    };
    const threadKey = buildThreadKey(normalizedPane.threadId, normalizedPane.connectionUrl);
    if (paneById.has(normalizedPane.id) || seenThreadKeys.has(threadKey)) {
      continue;
    }
    paneById.set(normalizedPane.id, normalizedPane);
    seenThreadKeys.add(threadKey);
  }

  if (paneById.size === 0) {
    return {
      activePaneId: null,
      paneRatios: [],
      panes: [],
      rows: [],
    };
  }

  const assignedPaneIds = new Set<string>();
  const rows: ChatThreadBoardRowState[] = [];
  for (const row of input.rows) {
    const paneIds = row.paneIds.filter((paneId) => {
      if (!paneById.has(paneId) || assignedPaneIds.has(paneId)) {
        return false;
      }
      assignedPaneIds.add(paneId);
      return true;
    });
    if (paneIds.length === 0) {
      continue;
    }
    rows.push(createRow(paneIds, { id: row.id, paneRatios: row.paneRatios }));
  }

  const unassignedPaneIds = [...paneById.keys()].filter((paneId) => !assignedPaneIds.has(paneId));
  if (unassignedPaneIds.length > 0) {
    rows.push(createRow(unassignedPaneIds));
  }

  const panes = [...paneById.values()].filter((pane) =>
    rows.some((row) => row.paneIds.includes(pane.id)),
  );
  const activePaneId =
    input.activePaneId && paneById.has(input.activePaneId)
      ? input.activePaneId
      : (rows[0]?.paneIds[0] ?? null);

  return {
    activePaneId,
    paneRatios: normalizePaneRatios(input.paneRatios, rows.length),
    panes,
    rows,
  };
}

function normalizeSplitState(input: ChatThreadBoardSplitState): ChatThreadBoardSplitState | null {
  const board = normalizeBoardState(input);
  if (board.panes.length <= 1) {
    return null;
  }
  const now = createTimestamp();
  return {
    ...board,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt || now,
    id: input.id || `split-${randomUUID()}`,
    title: input.title.trim() || "Untitled board",
    updatedAt: input.updatedAt || now,
  };
}

function normalizePersistedState(
  input: Partial<PersistedChatThreadBoardState>,
): PersistedChatThreadBoardState {
  const board = normalizeBoardState({
    activePaneId: input.activePaneId ?? null,
    paneRatios: input.paneRatios ?? [],
    panes: input.panes ?? [],
    rows: input.rows ?? [],
  });
  const splits: ChatThreadBoardSplitState[] = [];
  const seenSplitIds = new Set<string>();
  for (const split of input.splits ?? []) {
    const normalized = normalizeSplitState(split);
    if (!normalized || seenSplitIds.has(normalized.id)) {
      continue;
    }
    splits.push(normalized);
    seenSplitIds.add(normalized.id);
  }
  if (splits.length === 0 && board.panes.length > 1) {
    const migratedSplit = createSplitFromBoard({
      board,
      splitId: `split-${randomUUID()}`,
      title: "Previous board",
    });
    if (migratedSplit) {
      splits.push(migratedSplit);
      seenSplitIds.add(migratedSplit.id);
    }
  }
  return {
    ...board,
    activeSplitId:
      input.activeSplitId && seenSplitIds.has(input.activeSplitId) ? input.activeSplitId : null,
    splits,
  };
}

function saveBoardToActiveSplit(
  state: PersistedChatThreadBoardState,
  board: BoardStateFields,
): PersistedChatThreadBoardState {
  const normalizedBoard = normalizeBoardState(board);
  if (!state.activeSplitId || normalizedBoard.panes.length <= 1) {
    return {
      ...state,
      ...normalizedBoard,
      activeSplitId: normalizedBoard.panes.length > 1 ? state.activeSplitId : null,
    };
  }

  const now = createTimestamp();
  let found = false;
  const splits = state.splits.map((split) => {
    if (split.id !== state.activeSplitId) {
      return split;
    }
    found = true;
    return {
      ...split,
      ...normalizedBoard,
      updatedAt: now,
    };
  });

  if (!found) {
    splits.push({
      ...normalizedBoard,
      archivedAt: null,
      createdAt: now,
      id: state.activeSplitId,
      title: createSplitTitle(splits.length + 1),
      updatedAt: now,
    });
  }

  return {
    ...state,
    ...normalizedBoard,
    splits,
  };
}

function createSplitFromBoard(input: {
  board: BoardStateFields;
  splitId?: string;
  title: string;
}): ChatThreadBoardSplitState | null {
  const board = normalizeBoardState(input.board);
  if (board.panes.length <= 1) {
    return null;
  }
  const now = createTimestamp();
  return {
    ...board,
    archivedAt: null,
    createdAt: now,
    id: input.splitId ?? `split-${randomUUID()}`,
    title: input.title.trim() || "Untitled board",
    updatedAt: now,
  };
}

function findPaneIndex(
  panes: readonly ChatThreadBoardPaneState[],
  input: { connectionUrl?: string | null; threadId: ThreadId },
): number {
  const normalizedConnectionUrl = normalizeConnectionUrl(input.connectionUrl);
  return panes.findIndex(
    (pane) => pane.threadId === input.threadId && pane.connectionUrl === normalizedConnectionUrl,
  );
}

function findRowIndexByPaneId(rows: readonly ChatThreadBoardRowState[], paneId: string): number {
  return rows.findIndex((row) => row.paneIds.includes(paneId));
}

function withUpdatedPane(
  state: BoardStateFields,
  paneId: string,
  updater: (pane: ChatThreadBoardPaneState) => ChatThreadBoardPaneState,
): BoardStateFields {
  const paneIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (paneIndex < 0) {
    return state;
  }
  const panes = [...state.panes];
  panes[paneIndex] = updater(panes[paneIndex]!);
  return normalizeBoardState({ ...state, panes });
}

function insertPaneIntoBoard(
  state: BoardStateFields,
  pane: ChatThreadBoardPaneState,
  options?: {
    direction?: "down" | "right" | undefined;
    sourcePaneId?: string | null | undefined;
  },
): BoardStateFields {
  if (state.panes.length === 0 || state.rows.length === 0) {
    return normalizeBoardState({
      activePaneId: pane.id,
      paneRatios: [1],
      panes: [pane],
      rows: [createRow([pane.id])],
    });
  }

  const sourcePaneId =
    options?.sourcePaneId ?? state.activePaneId ?? state.rows[0]?.paneIds[0] ?? null;
  if (!sourcePaneId) {
    return normalizeBoardState({
      ...state,
      activePaneId: pane.id,
      panes: [...state.panes, pane],
      rows: [...state.rows, createRow([pane.id])],
    });
  }

  const sourceRowIndex = findRowIndexByPaneId(state.rows, sourcePaneId);
  if (sourceRowIndex < 0) {
    return normalizeBoardState({
      ...state,
      activePaneId: pane.id,
      panes: [...state.panes, pane],
      rows: [...state.rows, createRow([pane.id])],
    });
  }

  const rows = [...state.rows];
  const panes = [...state.panes, pane];

  if (options?.direction === "down") {
    rows.splice(sourceRowIndex + 1, 0, createRow([pane.id]));
  } else {
    const sourceRow = rows[sourceRowIndex]!;
    const sourcePaneIndex = sourceRow.paneIds.indexOf(sourcePaneId);
    const paneIds = [...sourceRow.paneIds];
    paneIds.splice(sourcePaneIndex + 1, 0, pane.id);
    rows[sourceRowIndex] = createRow(paneIds, {
      id: sourceRow.id,
      paneRatios: sourceRow.paneRatios,
    });
  }

  return normalizeBoardState({
    activePaneId: state.activePaneId ?? state.rows[0]?.paneIds[0] ?? pane.id,
    paneRatios: state.paneRatios,
    panes,
    rows,
  });
}

function replacePaneThread(
  state: BoardStateFields,
  paneId: string,
  input: { connectionUrl?: string | null; threadId: ThreadId },
): BoardStateFields {
  return withUpdatedPane(state, paneId, (pane) => ({
    ...pane,
    connectionUrl: normalizeConnectionUrl(input.connectionUrl),
    threadId: input.threadId,
  }));
}

function getOrderedBoardPaneIds(state: BoardStateFields): string[] {
  const orderedPaneIds: string[] = [];
  const seenPaneIds = new Set<string>();
  for (const row of state.rows) {
    for (const paneId of row.paneIds) {
      if (seenPaneIds.has(paneId)) {
        continue;
      }
      orderedPaneIds.push(paneId);
      seenPaneIds.add(paneId);
    }
  }
  for (const pane of state.panes) {
    if (seenPaneIds.has(pane.id)) {
      continue;
    }
    orderedPaneIds.push(pane.id);
    seenPaneIds.add(pane.id);
  }
  return orderedPaneIds;
}

function applyGridLayout(state: BoardStateFields, input: { columns: number }): BoardStateFields {
  const orderedPaneIds = getOrderedBoardPaneIds(state);
  if (orderedPaneIds.length === 0) {
    return normalizeBoardState(state);
  }

  const columnCount = Math.max(1, Math.min(orderedPaneIds.length, Math.floor(input.columns)));
  const rows: ChatThreadBoardRowState[] = [];
  for (let index = 0; index < orderedPaneIds.length; index += columnCount) {
    rows.push(createRow(orderedPaneIds.slice(index, index + columnCount)));
  }

  return normalizeBoardState({
    activePaneId: state.activePaneId,
    paneRatios: [],
    panes: state.panes,
    rows,
  });
}

function syncBoardThreadsFromRoute(
  state: BoardStateFields,
  input: {
    activeThread?: { connectionUrl?: string | null; threadId: ThreadId } | null;
    threads: ReadonlyArray<{ connectionUrl?: string | null; threadId: ThreadId }>;
  },
): BoardStateFields {
  const normalizedInputs: Array<{ connectionUrl: string | null; threadId: ThreadId }> = [];
  const seenThreadKeys = new Set<string>();
  for (const thread of input.threads) {
    const connectionUrl = normalizeConnectionUrl(thread.connectionUrl);
    const threadKey = buildThreadKey(thread.threadId, connectionUrl);
    if (seenThreadKeys.has(threadKey)) {
      continue;
    }
    seenThreadKeys.add(threadKey);
    normalizedInputs.push({ connectionUrl, threadId: thread.threadId });
  }

  if (normalizedInputs.length === 0) {
    return state;
  }

  const existingPaneByThreadKey = new Map(
    state.panes.map((pane) => [buildThreadKey(pane.threadId, pane.connectionUrl), pane] as const),
  );
  const panes = normalizedInputs.map((thread) => {
    const threadKey = buildThreadKey(thread.threadId, thread.connectionUrl);
    const existingPane = existingPaneByThreadKey.get(threadKey);
    return existingPane
      ? Object.assign({}, existingPane, {
          connectionUrl: thread.connectionUrl,
          threadId: thread.threadId,
        })
      : createPane(thread);
  });
  const desiredPaneIds = new Set(panes.map((pane) => pane.id));
  const assignedPaneIds = new Set<string>();
  const rows = state.rows
    .map((row) => {
      const paneIds = row.paneIds.filter((paneId) => {
        if (!desiredPaneIds.has(paneId) || assignedPaneIds.has(paneId)) {
          return false;
        }
        assignedPaneIds.add(paneId);
        return true;
      });
      return createRow(paneIds, { id: row.id, paneRatios: row.paneRatios });
    })
    .filter((row) => row.paneIds.length > 0);
  const unassignedPaneIds = panes
    .map((pane) => pane.id)
    .filter((paneId) => !assignedPaneIds.has(paneId));

  if (rows.length === 0) {
    rows.push(createRow(unassignedPaneIds));
  } else if (unassignedPaneIds.length > 0) {
    const activeThreadConnectionUrl = normalizeConnectionUrl(input.activeThread?.connectionUrl);
    const activeThreadKey = input.activeThread
      ? buildThreadKey(input.activeThread.threadId, activeThreadConnectionUrl)
      : null;
    const activePane =
      activeThreadKey === null
        ? null
        : panes.find(
            (pane) => buildThreadKey(pane.threadId, pane.connectionUrl) === activeThreadKey,
          );
    const activeRowIndex = activePane
      ? rows.findIndex((row) => row.paneIds.includes(activePane.id))
      : 0;
    const targetRowIndex = activeRowIndex >= 0 ? activeRowIndex : 0;
    const targetRow = rows[targetRowIndex]!;
    rows[targetRowIndex] = createRow([...targetRow.paneIds, ...unassignedPaneIds], {
      id: targetRow.id,
      paneRatios: targetRow.paneRatios,
    });
  }

  const activeThreadConnectionUrl = normalizeConnectionUrl(input.activeThread?.connectionUrl);
  const activeThreadKey = input.activeThread
    ? buildThreadKey(input.activeThread.threadId, activeThreadConnectionUrl)
    : null;
  const activePane =
    activeThreadKey === null
      ? null
      : panes.find((pane) => buildThreadKey(pane.threadId, pane.connectionUrl) === activeThreadKey);

  return normalizeBoardState({
    activePaneId: activePane?.id ?? panes[0]?.id ?? null,
    paneRatios: state.paneRatios,
    panes,
    rows,
  });
}

export const useChatThreadBoardStore = create<ChatThreadBoardStoreState>()(
  persist(
    (set) => ({
      ...createDefaultBoardState(),
      archiveSplit: (splitId) => {
        set((state) => {
          const now = createTimestamp();
          return {
            activeSplitId: state.activeSplitId === splitId ? null : state.activeSplitId,
            splits: state.splits.map((split) =>
              split.id === splitId ? { ...split, archivedAt: now, updatedAt: now } : split,
            ),
          };
        });
      },
      closePane: (paneId) => {
        set((state) => {
          if (state.panes.length <= 1) {
            return state;
          }

          const panes = state.panes.filter((pane) => pane.id !== paneId);
          const rows = state.rows
            .map((row) => {
              if (!row.paneIds.includes(paneId)) {
                return row;
              }
              return createRow(
                row.paneIds.filter((candidatePaneId) => candidatePaneId !== paneId),
                {
                  id: row.id,
                  paneRatios: row.paneRatios,
                },
              );
            })
            .filter((row) => row.paneIds.length > 0);
          const fallbackActivePaneId =
            state.activePaneId === paneId ? (rows[0]?.paneIds[0] ?? null) : state.activePaneId;
          return saveBoardToActiveSplit(state, {
            activePaneId: fallbackActivePaneId,
            paneRatios: state.paneRatios,
            panes,
            rows,
          });
        });
      },
      createSplit: (input) => {
        let splitId: string | null = null;
        set((state) => {
          const board = syncBoardThreadsFromRoute(createDefaultBoardState(), {
            activeThread: input.activeThread,
            threads: input.threads,
          });
          const split = createSplitFromBoard({
            board,
            title: input.title ?? createSplitTitle(state.splits.length + 1),
          });
          if (!split) {
            return state;
          }
          splitId = split.id;
          return {
            ...state,
            ...board,
            activeSplitId: split.id,
            splits: [...state.splits, split],
          };
        });
        return splitId;
      },
      deleteSplit: (splitId) => {
        set((state) => ({
          activeSplitId: state.activeSplitId === splitId ? null : state.activeSplitId,
          splits: state.splits.filter((split) => split.id !== splitId),
        }));
      },
      openThreadInBoard: (input) => {
        let openedPaneId: string | null = null;
        set((state) => {
          const existingPaneIndex = findPaneIndex(state.panes, input);
          if (existingPaneIndex >= 0) {
            openedPaneId = state.panes[existingPaneIndex]!.id;
            return saveBoardToActiveSplit(state, state);
          }

          const pane = createPane(input);
          openedPaneId = pane.id;
          return saveBoardToActiveSplit(
            state,
            insertPaneIntoBoard(state, pane, {
              direction: input.direction,
              sourcePaneId: input.sourcePaneId,
            }),
          );
        });
        return openedPaneId;
      },
      openThreadsInBoard: (inputs, options) => {
        let lastOpenedPaneId: string | null = null;
        set((state) => {
          const existingThreadKeys = new Set(
            state.panes.map((pane) => buildThreadKey(pane.threadId, pane.connectionUrl)),
          );
          const nextInputs = inputs.filter((input) => {
            const threadKey = buildThreadKey(
              input.threadId,
              normalizeConnectionUrl(input.connectionUrl),
            );
            if (existingThreadKeys.has(threadKey)) {
              return false;
            }
            existingThreadKeys.add(threadKey);
            return true;
          });

          if (nextInputs.length === 0) {
            return saveBoardToActiveSplit(state, state);
          }
          if (nextInputs.length === 1) {
            const pane = createPane(nextInputs[0]!);
            lastOpenedPaneId = pane.id;
            return saveBoardToActiveSplit(
              state,
              insertPaneIntoBoard(state, pane, {
                direction: "right",
                sourcePaneId: options?.sourcePaneId,
              }),
            );
          }

          const rows = [...state.rows];
          const panes = [...state.panes];
          const sourcePaneId =
            options?.sourcePaneId ?? state.activePaneId ?? state.rows[0]?.paneIds[0] ?? null;
          const anchorRowIndex =
            sourcePaneId !== null ? findRowIndexByPaneId(rows, sourcePaneId) : rows.length - 1;
          const insertAtIndex = anchorRowIndex >= 0 ? anchorRowIndex + 1 : rows.length;
          const appendedRows: ChatThreadBoardRowState[] = [];

          for (let index = 0; index < nextInputs.length; index += BOARD_MULTI_OPEN_COLUMNS) {
            const chunk = nextInputs.slice(index, index + BOARD_MULTI_OPEN_COLUMNS);
            const chunkPanes = chunk.map((item) => createPane(item));
            for (const pane of chunkPanes) {
              panes.push(pane);
              lastOpenedPaneId = pane.id;
            }
            appendedRows.push(createRow(chunkPanes.map((pane) => pane.id)));
          }

          rows.splice(insertAtIndex, 0, ...appendedRows);
          return saveBoardToActiveSplit(state, {
            activePaneId: state.activePaneId ?? state.rows[0]?.paneIds[0] ?? lastOpenedPaneId,
            paneRatios: state.paneRatios,
            panes,
            rows,
          });
        });
        return lastOpenedPaneId;
      },
      renameSplit: (splitId, title) => {
        set((state) => {
          const trimmed = title.trim();
          if (!trimmed) {
            return state;
          }
          const now = createTimestamp();
          return {
            splits: state.splits.map((split) =>
              split.id === splitId ? { ...split, title: trimmed, updatedAt: now } : split,
            ),
          };
        });
      },
      restoreSplit: (splitId, activePaneId) => {
        let restoredPaneId: string | null = null;
        set((state) => {
          const split = state.splits.find((candidate) => candidate.id === splitId);
          if (!split || split.archivedAt) {
            return state;
          }
          const board = normalizeBoardState({
            activePaneId: activePaneId ?? split.activePaneId,
            paneRatios: split.paneRatios,
            panes: split.panes,
            rows: split.rows,
          });
          restoredPaneId = board.activePaneId;
          return {
            ...state,
            ...board,
            activeSplitId: split.id,
          };
        });
        return restoredPaneId;
      },
      setActivePane: (paneId) => {
        set((state) =>
          paneId === null || state.panes.some((pane) => pane.id === paneId)
            ? saveBoardToActiveSplit(state, { ...state, activePaneId: paneId })
            : state,
        );
      },
      setActiveSplit: (splitId) => {
        set((state) => ({
          activeSplitId:
            splitId !== null && state.splits.some((split) => split.id === splitId) ? splitId : null,
        }));
      },
      setGridLayout: (input) => {
        set((state) => saveBoardToActiveSplit(state, applyGridLayout(state, input)));
      },
      setSplitGridLayout: (splitId, input) => {
        set((state) => {
          const split = state.splits.find((candidate) => candidate.id === splitId);
          if (!split || split.archivedAt) {
            return state;
          }
          const nextSplitBoard = applyGridLayout(
            {
              activePaneId: split.activePaneId,
              paneRatios: split.paneRatios,
              panes: split.panes,
              rows: split.rows,
            },
            input,
          );
          const now = createTimestamp();
          const splits = state.splits.map((candidate) =>
            candidate.id === splitId
              ? {
                  ...candidate,
                  activePaneId: nextSplitBoard.activePaneId,
                  paneRatios: nextSplitBoard.paneRatios,
                  panes: nextSplitBoard.panes,
                  rows: nextSplitBoard.rows,
                  updatedAt: now,
                }
              : candidate,
          );
          if (state.activeSplitId !== splitId) {
            return { splits };
          }
          return {
            ...state,
            ...nextSplitBoard,
            activeSplitId: splitId,
            splits,
          };
        });
      },
      setPaneRatios: (rowId, ratios) => {
        set((state) =>
          saveBoardToActiveSplit(state, {
            ...state,
            rows: state.rows.map((row) =>
              row.id === rowId
                ? {
                    ...row,
                    paneRatios: normalizePaneRatios(ratios, row.paneIds.length),
                  }
                : row,
            ),
          }),
        );
      },
      setRowRatios: (ratios) => {
        set((state) =>
          saveBoardToActiveSplit(state, {
            ...state,
            paneRatios: normalizePaneRatios(ratios, state.rows.length),
          }),
        );
      },
      syncRouteThread: (input) => {
        let paneId = "";
        set((state) => {
          const existingPaneIndex = findPaneIndex(state.panes, input);
          if (existingPaneIndex >= 0) {
            paneId = state.panes[existingPaneIndex]!.id;
            return {
              ...state,
              activePaneId: paneId,
              activeSplitId: null,
            };
          }

          if (state.panes.length === 0) {
            const pane = createPane(input);
            paneId = pane.id;
            return {
              ...state,
              ...insertPaneIntoBoard(state, pane),
              activeSplitId: null,
            };
          }

          if (state.panes.length === 1) {
            const solePane = state.panes[0]!;
            paneId = solePane.id;
            return {
              ...state,
              ...replacePaneThread(state, solePane.id, input),
              activeSplitId: null,
            };
          }

          const activePaneId =
            state.activePaneId ?? state.rows[0]?.paneIds[0] ?? state.panes[0]?.id;
          if (!activePaneId) {
            const pane = createPane(input);
            paneId = pane.id;
            return {
              ...state,
              ...insertPaneIntoBoard(state, pane),
              activeSplitId: null,
            };
          }
          paneId = activePaneId;
          return {
            ...state,
            ...replacePaneThread(state, activePaneId, input),
            activePaneId,
            activeSplitId: null,
          };
        });
        return paneId;
      },
      syncRouteThreads: (input) => {
        let activePaneId: string | null = null;
        set((state) => {
          const nextState = syncBoardThreadsFromRoute(state, input);
          activePaneId = nextState.activePaneId;
          return saveBoardToActiveSplit(state, nextState);
        });
        return activePaneId;
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        activeSplitId: state.activeSplitId,
        activePaneId: state.activePaneId,
        paneRatios: state.paneRatios,
        panes: state.panes,
        rows: state.rows,
        splits: state.splits,
      }),
      storage: createJSONStorage(createChatThreadBoardStorage),
      merge: (persisted, current) => ({
        ...current,
        ...normalizePersistedState(
          typeof persisted === "object" && persisted !== null
            ? (persisted as Partial<PersistedChatThreadBoardState>)
            : {},
        ),
      }),
      version: 2,
    },
  ),
);

export function selectBoardPaneById(
  panes: readonly ChatThreadBoardPaneState[],
  paneId: string | null | undefined,
): ChatThreadBoardPaneState | undefined {
  if (!paneId) {
    return undefined;
  }
  return panes.find((pane) => pane.id === paneId);
}
