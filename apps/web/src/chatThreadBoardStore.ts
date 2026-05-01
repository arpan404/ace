import type { ThreadId } from "@ace/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { normalizePaneRatios } from "./lib/paneRatios";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";
import { normalizeThreadBoardConnectionUrl } from "./lib/threadBoardThreads";
import { randomUUID } from "./lib/utils";

export interface ChatThreadBoardPaneState {
  connectionUrl: string | null;
  id: string;
  threadId: ThreadId;
}

export type ChatThreadBoardLayoutAxis = "horizontal" | "vertical";

export interface ChatThreadBoardLeafNode {
  id: string;
  kind: "pane";
  paneId: string;
}

export interface ChatThreadBoardSplitNode {
  axis: ChatThreadBoardLayoutAxis;
  children: ChatThreadBoardLayoutNode[];
  id: string;
  kind: "split";
  ratios: number[];
}

export type ChatThreadBoardLayoutNode = ChatThreadBoardLeafNode | ChatThreadBoardSplitNode;

export interface ChatThreadBoardSplitState {
  activePaneId: string | null;
  archivedAt: string | null;
  createdAt: string;
  id: string;
  layoutRoot: ChatThreadBoardLayoutNode | null;
  panes: ChatThreadBoardPaneState[];
  title: string;
  updatedAt: string;
}

interface PersistedChatThreadBoardState {
  activePaneId: string | null;
  activeSplitId: string | null;
  layoutRoot: ChatThreadBoardLayoutNode | null;
  panes: ChatThreadBoardPaneState[];
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
    allowDuplicate?: boolean;
    connectionUrl?: string | null;
    direction?: "down" | "left" | "right" | "up";
    sourcePaneId?: string | null;
    threadId: ThreadId;
    title?: string | undefined;
  }) => string | null;
  openThreadInSplit: (
    splitId: string,
    input: {
      allowDuplicate?: boolean;
      connectionUrl?: string | null;
      direction?: "down" | "left" | "right" | "up";
      sourcePaneId?: string | null;
      threadId: ThreadId;
    },
  ) => string | null;
  openThreadsInBoard: (
    inputs: ReadonlyArray<{
      connectionUrl?: string | null;
      threadId: ThreadId;
    }>,
    options?: { sourcePaneId?: string | null },
  ) => string | null;
  movePane: (input: {
    direction: "down" | "left" | "right" | "up";
    paneId: string;
    targetPaneId: string;
  }) => string | null;
  renameSplit: (splitId: string, title: string) => void;
  restoreSplit: (splitId: string, activePaneId?: string | null) => string | null;
  setActivePane: (paneId: string | null) => void;
  setActiveSplit: (splitId: string | null) => void;
  setBranchRatios: (branchId: string, ratios: readonly number[]) => void;
  syncRouteThread: (input: { connectionUrl?: string | null; threadId: ThreadId }) => string;
  syncRouteThreads: (input: {
    activeThread?: { connectionUrl?: string | null; threadId: ThreadId } | null;
    threads: ReadonlyArray<{ connectionUrl?: string | null; threadId: ThreadId }>;
  }) => string | null;
}

interface LegacyChatThreadBoardRowState {
  id?: string;
  paneIds?: readonly string[];
  paneRatios?: readonly number[];
}

interface LegacyBoardStateFields {
  activePaneId?: string | null;
  layoutRoot?: ChatThreadBoardLayoutNode | null;
  paneRatios?: readonly number[];
  panes?: readonly ChatThreadBoardPaneState[];
  rows?: readonly LegacyChatThreadBoardRowState[];
}

type BoardStateFields = Pick<
  PersistedChatThreadBoardState,
  "activePaneId" | "layoutRoot" | "panes"
>;

type InsertDirection = "down" | "left" | "right" | "up";

const STORAGE_KEY = "ace:chat-thread-board:v1";
const CHAT_THREAD_BOARD_PERSIST_DEBOUNCE_MS = 300;

const chatThreadBoardDebouncedStorage = createDebouncedStorage(
  typeof window !== "undefined" ? window.localStorage : createMemoryStorage(),
  CHAT_THREAD_BOARD_PERSIST_DEBOUNCE_MS,
);

if (typeof window !== "undefined") {
  const flushChatThreadBoardStorage = () => {
    chatThreadBoardDebouncedStorage.flush();
  };
  window.addEventListener("beforeunload", flushChatThreadBoardStorage);
  window.addEventListener("pagehide", flushChatThreadBoardStorage);
}

function createChatThreadBoardStorage() {
  return chatThreadBoardDebouncedStorage;
}

function createTimestamp(): string {
  return new Date().toISOString();
}

function createSplitTitle(index: number): string {
  return `Board ${index}`;
}

function createPane(input: {
  connectionUrl?: string | null;
  id?: string;
  threadId: ThreadId;
}): ChatThreadBoardPaneState {
  return {
    connectionUrl: normalizeThreadBoardConnectionUrl(input.connectionUrl),
    id: input.id ?? `pane-${randomUUID()}`,
    threadId: input.threadId,
  };
}

function getBoardThreadKey(input: { connectionUrl?: string | null; threadId: ThreadId }): string {
  return `${input.threadId}\u0000${normalizeThreadBoardConnectionUrl(input.connectionUrl) ?? ""}`;
}

function createLayoutLeaf(paneId: string, id?: string): ChatThreadBoardLeafNode {
  return {
    id: id ?? `pane-node-${randomUUID()}`,
    kind: "pane",
    paneId,
  };
}

function createLayoutSplit(
  axis: ChatThreadBoardLayoutAxis,
  children: readonly ChatThreadBoardLayoutNode[],
  input?: { id?: string; ratios?: readonly number[] },
): ChatThreadBoardSplitNode {
  return {
    axis,
    children: [...children],
    id: input?.id ?? `split-node-${randomUUID()}`,
    kind: "split",
    ratios: normalizePaneRatios(input?.ratios ?? [], children.length),
  };
}

function createDefaultBoardState(): PersistedChatThreadBoardState {
  return {
    activePaneId: null,
    activeSplitId: null,
    layoutRoot: null,
    panes: [],
    splits: [],
  };
}

function toLegacyBoardStateFields(input: {
  activePaneId?: string | null;
  layoutRoot?: ChatThreadBoardLayoutNode | null;
  paneRatios?: readonly number[] | undefined;
  panes?: readonly ChatThreadBoardPaneState[];
  rows?: readonly LegacyChatThreadBoardRowState[] | undefined;
}): LegacyBoardStateFields {
  const next: LegacyBoardStateFields = {
    activePaneId: input.activePaneId ?? null,
    layoutRoot: input.layoutRoot ?? null,
  };
  if (input.panes !== undefined) {
    next.panes = input.panes;
  }
  if (input.paneRatios !== undefined) {
    next.paneRatios = input.paneRatios;
  }
  if (input.rows !== undefined) {
    next.rows = input.rows;
  }
  return next;
}

function splitTargetRatio(
  ratios: readonly number[],
  targetIndex: number,
  nextChildCount: number,
  insertBefore: boolean,
): number[] {
  const current = normalizePaneRatios(ratios, nextChildCount - 1);
  const safeTargetIndex = Math.max(0, Math.min(targetIndex, current.length - 1));
  const targetRatio = current[safeTargetIndex] ?? 1 / nextChildCount;
  const insertedRatio = targetRatio / 2;
  const nextTargetRatio = targetRatio - insertedRatio;
  const insertionIndex = insertBefore ? safeTargetIndex : safeTargetIndex + 1;
  const next = [...current];
  next[safeTargetIndex] = nextTargetRatio;
  next.splice(insertionIndex, 0, insertedRatio);
  return normalizePaneRatios(next, nextChildCount);
}

function flattenLayoutPaneIds(root: ChatThreadBoardLayoutNode | null): string[] {
  if (!root) {
    return [];
  }
  if (root.kind === "pane") {
    return [root.paneId];
  }
  return root.children.flatMap((child) => flattenLayoutPaneIds(child));
}

function findFirstLayoutPaneId(root: ChatThreadBoardLayoutNode | null): string | null {
  return flattenLayoutPaneIds(root)[0] ?? null;
}

function layoutContainsPaneId(root: ChatThreadBoardLayoutNode | null, paneId: string): boolean {
  if (!root) {
    return false;
  }
  if (root.kind === "pane") {
    return root.paneId === paneId;
  }
  return root.children.some((child) => layoutContainsPaneId(child, paneId));
}

function normalizeLayoutNode(
  input: ChatThreadBoardLayoutNode | null | undefined,
  paneById: Map<string, ChatThreadBoardPaneState>,
  seenPaneIds: Set<string>,
): ChatThreadBoardLayoutNode | null {
  if (!input) {
    return null;
  }
  if (input.kind === "pane") {
    if (!paneById.has(input.paneId) || seenPaneIds.has(input.paneId)) {
      return null;
    }
    seenPaneIds.add(input.paneId);
    return createLayoutLeaf(input.paneId, input.id);
  }

  const children: ChatThreadBoardLayoutNode[] = [];
  for (const child of input.children ?? []) {
    const normalizedChild = normalizeLayoutNode(child, paneById, seenPaneIds);
    if (normalizedChild) {
      children.push(normalizedChild);
    }
  }

  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0]!;
  }

  return createLayoutSplit(input.axis === "vertical" ? "vertical" : "horizontal", children, {
    id: input.id,
    ratios: input.ratios,
  });
}

function buildLegacyLayoutRoot(
  rows: readonly LegacyChatThreadBoardRowState[],
  rowRatios: readonly number[],
  paneById: Map<string, ChatThreadBoardPaneState>,
): ChatThreadBoardLayoutNode | null {
  const seenPaneIds = new Set<string>();
  const rowNodes: ChatThreadBoardLayoutNode[] = [];

  for (const row of rows) {
    const paneIds = (row.paneIds ?? []).filter((paneId) => {
      if (!paneById.has(paneId) || seenPaneIds.has(paneId)) {
        return false;
      }
      seenPaneIds.add(paneId);
      return true;
    });
    if (paneIds.length === 0) {
      continue;
    }
    if (paneIds.length === 1) {
      rowNodes.push(createLayoutLeaf(paneIds[0]!));
      continue;
    }
    rowNodes.push(
      createLayoutSplit(
        "horizontal",
        paneIds.map((paneId) => createLayoutLeaf(paneId)),
        row.paneRatios !== undefined ? { ratios: row.paneRatios } : undefined,
      ),
    );
  }

  if (rowNodes.length === 0) {
    return null;
  }
  if (rowNodes.length === 1) {
    return rowNodes[0]!;
  }
  return createLayoutSplit("vertical", rowNodes, { ratios: rowRatios });
}

function buildLinearLayoutFromPaneIds(
  paneIds: readonly string[],
  axis: ChatThreadBoardLayoutAxis = "horizontal",
): ChatThreadBoardLayoutNode | null {
  if (paneIds.length === 0) {
    return null;
  }
  if (paneIds.length === 1) {
    return createLayoutLeaf(paneIds[0]!);
  }
  return createLayoutSplit(
    axis,
    paneIds.map((paneId) => createLayoutLeaf(paneId)),
  );
}

function appendPaneIdsToLayout(
  root: ChatThreadBoardLayoutNode | null,
  paneIds: readonly string[],
): ChatThreadBoardLayoutNode | null {
  if (paneIds.length === 0) {
    return root;
  }
  if (!root) {
    return buildLinearLayoutFromPaneIds(paneIds);
  }

  let nextRoot = root;
  let anchorPaneId = flattenLayoutPaneIds(root).at(-1) ?? null;
  for (const paneId of paneIds) {
    if (!anchorPaneId) {
      nextRoot = buildLinearLayoutFromPaneIds([paneId])!;
      anchorPaneId = paneId;
      continue;
    }
    const inserted = insertPaneIntoLayout(nextRoot, paneId, {
      direction: "right",
      sourcePaneId: anchorPaneId,
    });
    nextRoot = inserted.layoutRoot ?? nextRoot;
    anchorPaneId = paneId;
  }
  return nextRoot;
}

function normalizeBoardState(input: LegacyBoardStateFields): BoardStateFields {
  const paneById = new Map<string, ChatThreadBoardPaneState>();
  for (const pane of input.panes ?? []) {
    if (!pane?.id) {
      continue;
    }
    if (paneById.has(pane.id)) {
      continue;
    }
    const connectionUrl = normalizeThreadBoardConnectionUrl(pane.connectionUrl);
    paneById.set(
      pane.id,
      pane.connectionUrl === connectionUrl
        ? pane
        : {
            ...pane,
            connectionUrl,
          },
    );
  }

  if (paneById.size === 0) {
    return {
      activePaneId: null,
      layoutRoot: null,
      panes: [],
    };
  }

  const normalizedFromRoot = normalizeLayoutNode(
    input.layoutRoot ?? null,
    paneById,
    new Set<string>(),
  );
  const legacyRoot =
    normalizedFromRoot ?? buildLegacyLayoutRoot(input.rows ?? [], input.paneRatios ?? [], paneById);
  const assignedPaneIds = new Set(flattenLayoutPaneIds(legacyRoot));
  const unassignedPaneIds = [...paneById.keys()].filter((paneId) => !assignedPaneIds.has(paneId));
  const layoutRoot = appendPaneIdsToLayout(legacyRoot, unassignedPaneIds);
  const orderedPaneIds = flattenLayoutPaneIds(layoutRoot);
  const panes = [...paneById.values()];
  const activePaneId =
    input.activePaneId && orderedPaneIds.includes(input.activePaneId)
      ? input.activePaneId
      : (orderedPaneIds[0] ?? null);

  return {
    activePaneId,
    layoutRoot,
    panes,
  };
}

function boardLayoutNodesEqual(
  left: ChatThreadBoardLayoutNode | null,
  right: ChatThreadBoardLayoutNode | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.kind !== right.kind || left.id !== right.id) {
    return false;
  }
  if (left.kind === "pane" || right.kind === "pane") {
    return left.kind === "pane" && right.kind === "pane" && left.paneId === right.paneId;
  }
  if (left.axis !== right.axis || left.children.length !== right.children.length) {
    return false;
  }
  const leftRatios = normalizePaneRatios(left.ratios, left.children.length);
  const rightRatios = normalizePaneRatios(right.ratios, right.children.length);
  for (let index = 0; index < leftRatios.length; index += 1) {
    if (leftRatios[index] !== rightRatios[index]) {
      return false;
    }
  }
  return left.children.every((child, index) =>
    boardLayoutNodesEqual(child, right.children[index] ?? null),
  );
}

function boardPanesEqual(
  left: readonly ChatThreadBoardPaneState[],
  right: readonly ChatThreadBoardPaneState[],
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((leftPane, index) => {
    const rightPane = right[index];
    return (
      rightPane !== undefined &&
      leftPane.id === rightPane.id &&
      leftPane.threadId === rightPane.threadId &&
      leftPane.connectionUrl === rightPane.connectionUrl
    );
  });
}

function boardStatesEqual(left: BoardStateFields, right: BoardStateFields): boolean {
  return (
    left.activePaneId === right.activePaneId &&
    boardPanesEqual(left.panes, right.panes) &&
    boardLayoutNodesEqual(left.layoutRoot, right.layoutRoot)
  );
}

function normalizeSplitState(
  input: ChatThreadBoardSplitState | (Partial<ChatThreadBoardSplitState> & LegacyBoardStateFields),
): ChatThreadBoardSplitState | null {
  const legacyInput = input as Partial<LegacyBoardStateFields>;
  const board = normalizeBoardState(
    toLegacyBoardStateFields({
      activePaneId: input.activePaneId ?? null,
      layoutRoot: input.layoutRoot ?? null,
      paneRatios: legacyInput.paneRatios,
      panes: input.panes ?? [],
      rows: legacyInput.rows,
    }),
  );
  if (board.panes.length <= 1) {
    return null;
  }
  const now = createTimestamp();
  return {
    ...board,
    archivedAt: input.archivedAt ?? null,
    createdAt: input.createdAt || now,
    id: input.id || `split-${randomUUID()}`,
    title: input.title?.trim() || "Untitled board",
    updatedAt: input.updatedAt || now,
  };
}

function normalizePersistedState(
  input: Partial<PersistedChatThreadBoardState & LegacyBoardStateFields>,
): PersistedChatThreadBoardState {
  const board = normalizeBoardState(
    toLegacyBoardStateFields({
      activePaneId: input.activePaneId ?? null,
      layoutRoot: input.layoutRoot ?? null,
      paneRatios: input.paneRatios,
      panes: input.panes ?? [],
      rows: input.rows,
    }),
  );

  const splits: ChatThreadBoardSplitState[] = [];
  const seenSplitIds = new Set<string>();
  for (const rawSplit of input.splits ?? []) {
    const normalized = normalizeSplitState(
      rawSplit as ChatThreadBoardSplitState & LegacyBoardStateFields,
    );
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
  board: LegacyBoardStateFields,
  input?: { title?: string | null | undefined },
): PersistedChatThreadBoardState {
  const normalizedBoard = normalizeBoardState(board);
  if (boardStatesEqual(state, normalizedBoard)) {
    return state;
  }

  if (normalizedBoard.panes.length <= 1) {
    return {
      ...state,
      ...normalizedBoard,
      activeSplitId: null,
      splits: state.activeSplitId
        ? state.splits.filter((split) => split.id !== state.activeSplitId)
        : state.splits,
    };
  }

  if (!state.activeSplitId) {
    const split = createSplitFromBoard({
      board: normalizedBoard,
      title: input?.title ?? createSplitTitle(state.splits.length + 1),
    });
    if (!split) {
      return {
        ...state,
        ...normalizedBoard,
        activeSplitId: null,
      };
    }
    return {
      ...state,
      ...normalizedBoard,
      activeSplitId: split.id,
      splits: [...state.splits, split],
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

function saveBoardToSplit(
  state: PersistedChatThreadBoardState,
  splitId: string,
  board: LegacyBoardStateFields,
): PersistedChatThreadBoardState {
  const split = state.splits.find((candidate) => candidate.id === splitId);
  if (!split || split.archivedAt) {
    return state;
  }

  const normalizedBoard = normalizeBoardState(board);
  const now = createTimestamp();
  const splits = state.splits.map((candidate) =>
    candidate.id === splitId
      ? {
          ...candidate,
          ...normalizedBoard,
          updatedAt: now,
        }
      : candidate,
  );

  if (state.activeSplitId !== splitId) {
    return { ...state, splits };
  }

  return {
    ...state,
    ...normalizedBoard,
    activeSplitId: splitId,
    splits,
  };
}

function createSplitFromBoard(input: {
  board: LegacyBoardStateFields;
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

function boardStateFromOrderedThreads(input: {
  activeThread?: { connectionUrl?: string | null; threadId: ThreadId } | null;
  threads: ReadonlyArray<{ connectionUrl?: string | null; threadId: ThreadId }>;
}): BoardStateFields {
  const seenThreadKeys = new Set<string>();
  const normalizedThreads: Array<{ connectionUrl: string | null; threadId: ThreadId }> = [];
  for (const thread of input.threads) {
    const normalizedThread = {
      connectionUrl: normalizeThreadBoardConnectionUrl(thread.connectionUrl),
      threadId: thread.threadId,
    };
    const threadKey = getBoardThreadKey(normalizedThread);
    if (seenThreadKeys.has(threadKey)) {
      continue;
    }
    seenThreadKeys.add(threadKey);
    normalizedThreads.push(normalizedThread);
  }
  if (normalizedThreads.length === 0) {
    return createDefaultBoardState();
  }

  const panes = normalizedThreads.map((thread) => createPane(thread));
  const activeThreadConnectionUrl = normalizeThreadBoardConnectionUrl(
    input.activeThread?.connectionUrl,
  );
  const activePane =
    input.activeThread == null
      ? null
      : (panes.find(
          (pane) =>
            pane.threadId === input.activeThread?.threadId &&
            pane.connectionUrl === activeThreadConnectionUrl,
        ) ?? null);

  return normalizeBoardState({
    activePaneId: activePane?.id ?? panes[panes.length - 1]?.id ?? null,
    layoutRoot: buildLinearLayoutFromPaneIds(panes.map((pane) => pane.id)),
    panes,
  });
}

function boardStateFromRouteThread(
  state: BoardStateFields,
  input: { connectionUrl?: string | null; threadId: ThreadId },
): BoardStateFields {
  const normalizedConnectionUrl = normalizeThreadBoardConnectionUrl(input.connectionUrl);
  const reusablePane =
    state.panes.length === 1 &&
    state.panes[0]?.threadId === input.threadId &&
    state.panes[0]?.connectionUrl === normalizedConnectionUrl
      ? state.panes[0]
      : null;
  const pane =
    reusablePane ??
    createPane({
      connectionUrl: normalizedConnectionUrl,
      threadId: input.threadId,
    });

  return normalizeBoardState({
    activePaneId: pane.id,
    layoutRoot: buildLinearLayoutFromPaneIds([pane.id]),
    panes: [pane],
  });
}

function findPaneIndex(
  panes: readonly ChatThreadBoardPaneState[],
  input: { connectionUrl?: string | null; threadId: ThreadId },
): number {
  const targetKey = getBoardThreadKey(input);
  return panes.findIndex((pane) => getBoardThreadKey(pane) === targetKey);
}

function findAnchorPaneId(state: BoardStateFields, preferredPaneId?: string | null): string | null {
  if (preferredPaneId && state.panes.some((pane) => pane.id === preferredPaneId)) {
    return preferredPaneId;
  }
  if (state.activePaneId && state.panes.some((pane) => pane.id === state.activePaneId)) {
    return state.activePaneId;
  }
  return findFirstLayoutPaneId(state.layoutRoot) ?? state.panes[0]?.id ?? null;
}

function insertPaneIntoLayout(
  root: ChatThreadBoardLayoutNode | null,
  newPaneId: string,
  options?: {
    direction?: InsertDirection;
    sourcePaneId?: string | null;
  },
): { inserted: boolean; layoutRoot: ChatThreadBoardLayoutNode | null } {
  const direction = options?.direction ?? "right";
  const axis: ChatThreadBoardLayoutAxis =
    direction === "left" || direction === "right" ? "horizontal" : "vertical";
  const insertBefore = direction === "left" || direction === "up";
  const targetPaneId = options?.sourcePaneId ?? null;
  const newLeaf = createLayoutLeaf(newPaneId);

  if (!root || !targetPaneId) {
    return { inserted: true, layoutRoot: buildLinearLayoutFromPaneIds([newPaneId]) };
  }
  const resolvedTargetPaneId = targetPaneId;

  function visit(node: ChatThreadBoardLayoutNode): {
    inserted: boolean;
    nextNode: ChatThreadBoardLayoutNode;
  } {
    if (node.kind === "pane") {
      if (node.paneId !== resolvedTargetPaneId) {
        return { inserted: false, nextNode: node };
      }
      return {
        inserted: true,
        nextNode: createLayoutSplit(axis, insertBefore ? [newLeaf, node] : [node, newLeaf]),
      };
    }

    const childIndex = node.children.findIndex((child) =>
      layoutContainsPaneId(child, resolvedTargetPaneId),
    );
    if (childIndex < 0) {
      return { inserted: false, nextNode: node };
    }

    if (node.axis === axis) {
      const nextChildren = [...node.children];
      const insertionIndex = insertBefore ? childIndex : childIndex + 1;
      nextChildren.splice(insertionIndex, 0, newLeaf);
      return {
        inserted: true,
        nextNode: createLayoutSplit(node.axis, nextChildren, {
          id: node.id,
          ratios: splitTargetRatio(node.ratios, childIndex, nextChildren.length, insertBefore),
        }),
      };
    }

    const child = node.children[childIndex]!;
    const result = visit(child);
    if (!result.inserted) {
      return { inserted: false, nextNode: node };
    }
    const nextChildren = [...node.children];
    nextChildren[childIndex] = result.nextNode;
    return {
      inserted: true,
      nextNode: createLayoutSplit(node.axis, nextChildren, {
        id: node.id,
        ratios: node.ratios,
      }),
    };
  }

  const result = visit(root);
  if (result.inserted) {
    return { inserted: true, layoutRoot: result.nextNode };
  }

  return {
    inserted: true,
    layoutRoot: createLayoutSplit(axis, insertBefore ? [newLeaf, root!] : [root!, newLeaf]),
  };
}

function insertPaneIntoBoard(
  state: BoardStateFields,
  pane: ChatThreadBoardPaneState,
  options?: {
    direction?: InsertDirection;
    sourcePaneId?: string | null;
  },
): BoardStateFields {
  const sourcePaneId = findAnchorPaneId(state, options?.sourcePaneId);
  const inserted = insertPaneIntoLayout(state.layoutRoot, pane.id, {
    ...(options?.direction ? { direction: options.direction } : {}),
    ...(sourcePaneId ? { sourcePaneId } : {}),
  });

  return normalizeBoardState({
    activePaneId: pane.id,
    layoutRoot: inserted.layoutRoot,
    panes: [...state.panes, pane],
  });
}

function movePaneInBoard(
  state: BoardStateFields,
  input: { direction: InsertDirection; paneId: string; targetPaneId: string },
): BoardStateFields {
  if (input.paneId === input.targetPaneId || state.panes.length <= 1) {
    return state;
  }
  const sourcePane = state.panes.find((pane) => pane.id === input.paneId);
  if (!sourcePane || !layoutContainsPaneId(state.layoutRoot, input.targetPaneId)) {
    return state;
  }

  const layoutRootWithoutSource = removePaneFromLayout(state.layoutRoot, input.paneId);
  if (
    !layoutRootWithoutSource ||
    !layoutContainsPaneId(layoutRootWithoutSource, input.targetPaneId)
  ) {
    return state;
  }

  const moved = insertPaneIntoLayout(layoutRootWithoutSource, sourcePane.id, {
    direction: input.direction,
    sourcePaneId: input.targetPaneId,
  });

  return normalizeBoardState({
    activePaneId: sourcePane.id,
    layoutRoot: moved.layoutRoot,
    panes: state.panes,
  });
}

function removePaneFromLayout(
  root: ChatThreadBoardLayoutNode | null,
  paneId: string,
): ChatThreadBoardLayoutNode | null {
  if (!root) {
    return null;
  }
  if (root.kind === "pane") {
    return root.paneId === paneId ? null : root;
  }

  const nextChildren = root.children
    .map((child) => removePaneFromLayout(child, paneId))
    .filter((child): child is ChatThreadBoardLayoutNode => child !== null);

  if (nextChildren.length === 0) {
    return null;
  }
  if (nextChildren.length === 1) {
    return nextChildren[0]!;
  }
  return createLayoutSplit(root.axis, nextChildren, { id: root.id, ratios: root.ratios });
}

function updateBranchRatiosInLayout(
  root: ChatThreadBoardLayoutNode | null,
  branchId: string,
  ratios: readonly number[],
): ChatThreadBoardLayoutNode | null {
  if (!root) {
    return null;
  }
  if (root.kind === "pane") {
    return root;
  }
  if (root.id === branchId) {
    return createLayoutSplit(root.axis, root.children, { id: root.id, ratios });
  }
  return createLayoutSplit(
    root.axis,
    root.children.map((child) => updateBranchRatiosInLayout(child, branchId, ratios) ?? child),
    { id: root.id, ratios: root.ratios },
  );
}

function syncBoardThreadsFromRoute(
  state: BoardStateFields,
  input: {
    activeThread?: { connectionUrl?: string | null; threadId: ThreadId } | null;
    threads: ReadonlyArray<{ connectionUrl?: string | null; threadId: ThreadId }>;
  },
): BoardStateFields {
  if (input.threads.length === 0) {
    return state;
  }
  return boardStateFromOrderedThreads(input);
}

function openThreadsInBoardState(
  state: BoardStateFields,
  inputs: ReadonlyArray<{
    connectionUrl?: string | null;
    threadId: ThreadId;
  }>,
  options?: { sourcePaneId?: string | null },
): { board: BoardStateFields; lastOpenedPaneId: string | null } {
  let board = state;
  let lastOpenedPaneId: string | null = null;
  let sourcePaneId = findAnchorPaneId(state, options?.sourcePaneId);

  for (const input of inputs) {
    const existingPaneIndex = findPaneIndex(board.panes, input);
    if (existingPaneIndex >= 0) {
      lastOpenedPaneId = board.panes[existingPaneIndex]!.id;
      sourcePaneId = lastOpenedPaneId;
      board = normalizeBoardState({
        ...board,
        activePaneId: lastOpenedPaneId,
      });
      continue;
    }

    const pane = createPane(input);
    board = insertPaneIntoBoard(board, pane, {
      direction: "right",
      sourcePaneId,
    });
    lastOpenedPaneId = pane.id;
    sourcePaneId = pane.id;
  }

  return { board, lastOpenedPaneId };
}

export function orderBoardPanes(
  panes: readonly ChatThreadBoardPaneState[],
  layoutRoot: ChatThreadBoardLayoutNode | null,
): ChatThreadBoardPaneState[] {
  const paneById = new Map(panes.map((pane) => [pane.id, pane]));
  const orderedPanes: ChatThreadBoardPaneState[] = [];
  const seenPaneIds = new Set<string>();

  for (const paneId of flattenLayoutPaneIds(layoutRoot)) {
    const pane = paneById.get(paneId);
    if (!pane || seenPaneIds.has(pane.id)) {
      continue;
    }
    seenPaneIds.add(pane.id);
    orderedPanes.push(pane);
  }

  for (const pane of panes) {
    if (seenPaneIds.has(pane.id)) {
      continue;
    }
    seenPaneIds.add(pane.id);
    orderedPanes.push(pane);
  }

  return orderedPanes;
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
          const layoutRoot = removePaneFromLayout(state.layoutRoot, paneId);
          const fallbackActivePaneId =
            state.activePaneId === paneId
              ? (findFirstLayoutPaneId(layoutRoot) ?? null)
              : state.activePaneId;
          return saveBoardToActiveSplit(state, {
            activePaneId: fallbackActivePaneId,
            layoutRoot,
            panes,
          });
        });
      },
      createSplit: (input) => {
        let splitId: string | null = null;
        set((state) => {
          const board = boardStateFromOrderedThreads({
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
          const existingPaneIndex = input.allowDuplicate ? -1 : findPaneIndex(state.panes, input);
          if (existingPaneIndex >= 0) {
            openedPaneId = state.panes[existingPaneIndex]!.id;
            return saveBoardToActiveSplit(state, {
              ...state,
              activePaneId: openedPaneId,
            });
          }

          const pane = createPane(input);
          openedPaneId = pane.id;
          return saveBoardToActiveSplit(
            state,
            insertPaneIntoBoard(state, pane, {
              ...(input.direction ? { direction: input.direction } : {}),
              ...(input.sourcePaneId ? { sourcePaneId: input.sourcePaneId } : {}),
            }),
            { title: input.title },
          );
        });
        return openedPaneId;
      },
      openThreadInSplit: (splitId, input) => {
        let openedPaneId: string | null = null;
        set((state) => {
          const split = state.splits.find((candidate) => candidate.id === splitId);
          if (!split || split.archivedAt) {
            return state;
          }

          const board: BoardStateFields = {
            activePaneId: split.activePaneId,
            layoutRoot: split.layoutRoot,
            panes: split.panes,
          };
          const existingPaneIndex = input.allowDuplicate ? -1 : findPaneIndex(board.panes, input);
          if (existingPaneIndex >= 0) {
            openedPaneId = board.panes[existingPaneIndex]!.id;
            return saveBoardToSplit(state, splitId, {
              ...board,
              activePaneId: openedPaneId,
            });
          }

          const pane = createPane(input);
          openedPaneId = pane.id;
          return saveBoardToSplit(
            state,
            splitId,
            insertPaneIntoBoard(board, pane, {
              ...(input.direction ? { direction: input.direction } : {}),
              ...((input.sourcePaneId ?? split.activePaneId)
                ? { sourcePaneId: input.sourcePaneId ?? split.activePaneId }
                : {}),
            }),
          );
        });
        return openedPaneId;
      },
      openThreadsInBoard: (inputs, options) => {
        let lastOpenedPaneId: string | null = null;
        set((state) => {
          const nextBoard = openThreadsInBoardState(state, inputs, options);
          lastOpenedPaneId = nextBoard.lastOpenedPaneId;
          return saveBoardToActiveSplit(state, nextBoard.board);
        });
        return lastOpenedPaneId;
      },
      movePane: (input) => {
        let movedPaneId: string | null = null;
        set((state) => {
          const nextBoard = movePaneInBoard(state, input);
          if (nextBoard === state || nextBoard.activePaneId !== input.paneId) {
            return state;
          }
          movedPaneId = input.paneId;
          return saveBoardToActiveSplit(state, nextBoard);
        });
        return movedPaneId;
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
            layoutRoot: split.layoutRoot,
            panes: split.panes,
          });
          restoredPaneId = board.activePaneId;
          if (state.activeSplitId === split.id && boardStatesEqual(state, board)) {
            return state;
          }
          return {
            ...state,
            ...board,
            activeSplitId: split.id,
          };
        });
        return restoredPaneId;
      },
      setActivePane: (paneId) => {
        set((state) => {
          if (paneId === state.activePaneId) {
            return state;
          }
          return paneId === null || state.panes.some((pane) => pane.id === paneId)
            ? saveBoardToActiveSplit(state, { ...state, activePaneId: paneId })
            : state;
        });
      },
      setActiveSplit: (splitId) => {
        set((state) => ({
          activeSplitId:
            splitId !== null && state.splits.some((split) => split.id === splitId) ? splitId : null,
        }));
      },
      setBranchRatios: (branchId, ratios) => {
        set((state) =>
          saveBoardToActiveSplit(state, {
            ...state,
            layoutRoot: updateBranchRatiosInLayout(state.layoutRoot, branchId, ratios),
          }),
        );
      },
      syncRouteThread: (input) => {
        let paneId = "";
        set((state) => {
          const board = boardStateFromRouteThread(state, input);
          paneId = board.activePaneId ?? "";
          return {
            ...state,
            ...board,
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
      merge: (persisted, current) => ({
        ...current,
        ...normalizePersistedState(
          typeof persisted === "object" && persisted !== null
            ? (persisted as Partial<PersistedChatThreadBoardState & LegacyBoardStateFields>)
            : {},
        ),
      }),
      name: STORAGE_KEY,
      partialize: (state) => ({
        activePaneId: state.activePaneId,
        activeSplitId: state.activeSplitId,
        layoutRoot: state.layoutRoot,
        panes: state.panes,
        splits: state.splits,
      }),
      storage: createJSONStorage(createChatThreadBoardStorage),
      version: 3,
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
