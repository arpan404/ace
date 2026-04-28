import { Debouncer } from "@tanstack/react-pacer";
import { type ProjectId, type ThreadId } from "@ace/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

const PERSISTED_STATE_KEY = "ace:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "ace:renderer-state:v8",
  "ace:renderer-state:v7",
  "ace:renderer-state:v6",
  "ace:renderer-state:v5",
  "ace:renderer-state:v4",
  "ace:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

const PersistedUiStateSchema = Schema.Struct({
  boardsSectionExpanded: Schema.optional(Schema.Boolean),
  collapsedProjectCwds: Schema.optional(Schema.Array(Schema.String)),
  expandedProjectCwds: Schema.optional(Schema.Array(Schema.String)),
  pinnedItems: Schema.optional(
    Schema.Array(
      Schema.Struct({
        cwd: Schema.optional(Schema.String),
        id: Schema.optional(Schema.String),
        kind: Schema.Literals(["project", "thread"]),
      }),
    ),
  ),
  pinnedProjectCwds: Schema.optional(Schema.Array(Schema.String)),
  pinnedThreadIds: Schema.optional(Schema.Array(Schema.String)),
  projectOrderCwds: Schema.optional(Schema.Array(Schema.String)),
  projectsSectionExpanded: Schema.optional(Schema.Boolean),
  pinnedSectionExpanded: Schema.optional(Schema.Boolean),
  threadOrderByProjectCwds: Schema.optional(
    Schema.Record(Schema.String, Schema.Array(Schema.String)),
  ),
});
type PersistedUiState = typeof PersistedUiStateSchema.Type;
const decodePersistedUiState = Schema.decodeSync(Schema.fromJsonString(PersistedUiStateSchema));

export type UiPinnedItem = { kind: "project"; id: ProjectId } | { kind: "thread"; id: ThreadId };

export interface UiProjectState {
  boardsSectionExpanded: boolean;
  pinnedSectionExpanded: boolean;
  projectExpandedById: Record<string, boolean>;
  projectOrder: ProjectId[];
  projectsSectionExpanded: boolean;
}

export interface UiThreadState {
  pinnedItems: UiPinnedItem[];
  threadOrderByProjectId: Record<string, ThreadId[]>;
  threadLastVisitedAtById: Record<string, string>;
  activeThreadId: ThreadId | null;
  previousActiveThreadId: ThreadId | null;
}

export interface UiState extends UiProjectState, UiThreadState {}

export interface SyncProjectInput {
  id: ProjectId;
  cwd: string;
}

export interface SyncThreadInput {
  id: ThreadId;
  projectId?: ProjectId | undefined;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  boardsSectionExpanded: true,
  pinnedItems: [],
  pinnedSectionExpanded: true,
  threadOrderByProjectId: {},
  projectExpandedById: {},
  projectOrder: [],
  projectsSectionExpanded: true,
  threadLastVisitedAtById: {},
  activeThreadId: null,
  previousActiveThreadId: null,
};

const persistedCollapsedProjectCwds = new Set<string>();
const persistedExpandedProjectCwds = new Set<string>();
const persistedPinnedProjectCwds = new Set<string>();
const persistedPinnedThreadIds = new Set<string>();
const persistedThreadOrderByProjectCwd = new Map<string, ThreadId[]>();
const persistedProjectOrderCwds: string[] = [];
const currentProjectCwdById = new Map<ProjectId, string>();
let legacyKeysCleanedUp = false;

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        const parsed = decodePersistedUiState(legacyRaw);
        hydratePersistedProjectState(parsed);
        return hydratePersistedUiStateFields(initialState, parsed);
      }
      return initialState;
    }
    const parsed = decodePersistedUiState(raw);
    hydratePersistedProjectState(parsed);
    return hydratePersistedUiStateFields(initialState, parsed);
  } catch {
    return initialState;
  }
}

function hydratePersistedUiStateFields(state: UiState, parsed: PersistedUiState): UiState {
  return {
    ...state,
    boardsSectionExpanded: parsed.boardsSectionExpanded ?? state.boardsSectionExpanded,
    pinnedSectionExpanded: parsed.pinnedSectionExpanded ?? state.pinnedSectionExpanded,
    projectsSectionExpanded: parsed.projectsSectionExpanded ?? state.projectsSectionExpanded,
  };
}

function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedExpandedProjectCwds.clear();
  persistedCollapsedProjectCwds.clear();
  persistedPinnedProjectCwds.clear();
  persistedPinnedThreadIds.clear();
  persistedThreadOrderByProjectCwd.clear();
  persistedProjectOrderCwds.length = 0;
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.collapsedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedCollapsedProjectCwds.add(cwd);
    }
  }
  if (parsed.pinnedItems) {
    for (const item of parsed.pinnedItems) {
      if (item.kind === "project" && typeof item.cwd === "string" && item.cwd.length > 0) {
        persistedPinnedProjectCwds.add(item.cwd);
      }
      if (item.kind === "thread" && typeof item.id === "string" && item.id.length > 0) {
        persistedPinnedThreadIds.add(item.id);
      }
    }
  } else {
    for (const cwd of parsed.pinnedProjectCwds ?? []) {
      if (typeof cwd === "string" && cwd.length > 0) {
        persistedPinnedProjectCwds.add(cwd);
      }
    }
    for (const threadId of parsed.pinnedThreadIds ?? []) {
      if (typeof threadId === "string" && threadId.length > 0) {
        persistedPinnedThreadIds.add(threadId);
      }
    }
  }
  for (const [cwd, order] of Object.entries(parsed.threadOrderByProjectCwds ?? {})) {
    if (typeof cwd !== "string" || cwd.length === 0 || !Array.isArray(order)) {
      continue;
    }
    const cleanedOrder = order.flatMap((threadId) =>
      typeof threadId === "string" && threadId.length > 0 ? ([threadId as ThreadId] as const) : [],
    );
    if (cleanedOrder.length > 0) {
      persistedThreadOrderByProjectCwd.set(cwd, cleanedOrder);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
}

function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([projectId]) => {
        const cwd = currentProjectCwdById.get(projectId as ProjectId);
        return cwd ? [cwd] : [];
      });
    const collapsedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => !expanded)
      .flatMap(([projectId]) => {
        const cwd = currentProjectCwdById.get(projectId as ProjectId);
        return cwd ? [cwd] : [];
      });
    const pinnedItems: Array<{ kind: "project" | "thread"; cwd?: string; id?: string }> = [];
    for (const item of state.pinnedItems) {
      if (item.kind === "thread") {
        pinnedItems.push({ kind: "thread", id: item.id });
        continue;
      }
      const cwd = currentProjectCwdById.get(item.id);
      if (cwd) {
        pinnedItems.push({ kind: "project", cwd });
      }
    }
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    const threadOrderByProjectCwds = Object.fromEntries(
      Object.entries(state.threadOrderByProjectId)
        .flatMap(([projectId, threadOrder]) => {
          const cwd = currentProjectCwdById.get(projectId as ProjectId);
          if (!cwd || threadOrder.length === 0) {
            return [];
          }
          return [[cwd, threadOrder] as const];
        })
        .toSorted(([leftCwd], [rightCwd]) => leftCwd.localeCompare(rightCwd)),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        boardsSectionExpanded: state.boardsSectionExpanded,
        collapsedProjectCwds,
        expandedProjectCwds,
        pinnedItems,
        pinnedSectionExpanded: state.pinnedSectionExpanded,
        projectOrderCwds,
        projectsSectionExpanded: state.projectsSectionExpanded,
        threadOrderByProjectCwds,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function projectOrdersEqual(left: readonly ProjectId[], right: readonly ProjectId[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

function threadOrdersEqual(left: readonly ThreadId[], right: readonly ThreadId[]): boolean {
  return left.length === right.length && left.every((threadId, index) => threadId === right[index]);
}

function pinnedItemsEqual(left: readonly UiPinnedItem[], right: readonly UiPinnedItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const rightItem = right[index];
      return rightItem?.kind === item.kind && rightItem.id === item.id;
    })
  );
}

function threadOrdersByProjectEqual(
  left: Record<string, readonly ThreadId[]>,
  right: Record<string, readonly ThreadId[]>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [projectId, leftOrder] of leftEntries) {
    const rightOrder = right[projectId];
    if (!rightOrder || !threadOrdersEqual(leftOrder, rightOrder)) {
      return false;
    }
  }
  return true;
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousProjectIdByCwd = new Map(
    [...previousProjectCwdById.entries()].map(([projectId, cwd]) => [cwd, projectId] as const),
  );
  currentProjectCwdById.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.id, project.cwd);
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.id) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    const previousProjectIdForCwd = previousProjectIdByCwd.get(project.cwd);
    const expanded =
      previousExpandedById[project.id] ??
      (previousProjectIdForCwd ? previousExpandedById[previousProjectIdForCwd] : undefined) ??
      (persistedCollapsedProjectCwds.has(project.cwd) ? false : undefined) ??
      (persistedExpandedProjectCwds.size > 0
        ? persistedExpandedProjectCwds.has(project.cwd)
        : true);
    nextExpandedById[project.id] = expanded;
    return {
      id: project.id,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });
  const nextProjectIdByCwd = new Map(
    mappedProjects.map((project) => [project.cwd, project.id] as const),
  );
  const nextThreadOrderByProjectId: Record<string, ThreadId[]> = {};
  for (const [projectId, order] of Object.entries(state.threadOrderByProjectId)) {
    const matchedProjectId =
      (projectId in nextExpandedById ? (projectId as ProjectId) : undefined) ??
      (() => {
        const previousCwd = previousProjectCwdById.get(projectId as ProjectId);
        return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
      })();
    if (!matchedProjectId || order.length === 0) {
      continue;
    }
    const existingOrder = nextThreadOrderByProjectId[matchedProjectId] ?? [];
    const mergedOrder = [...existingOrder];
    const seen = new Set(existingOrder);
    for (const threadId of order) {
      if (seen.has(threadId)) {
        continue;
      }
      seen.add(threadId);
      mergedOrder.push(threadId);
    }
    nextThreadOrderByProjectId[matchedProjectId] = mergedOrder;
  }
  for (const project of mappedProjects) {
    const persistedOrder = persistedThreadOrderByProjectCwd.get(project.cwd);
    if (!persistedOrder || persistedOrder.length === 0) {
      continue;
    }
    const existingOrder = nextThreadOrderByProjectId[project.id] ?? [];
    const mergedOrder = [...existingOrder];
    const seen = new Set(existingOrder);
    for (const threadId of persistedOrder) {
      if (seen.has(threadId)) {
        continue;
      }
      seen.add(threadId);
      mergedOrder.push(threadId);
    }
    nextThreadOrderByProjectId[project.id] = mergedOrder;
  }
  const nextPinnedItems: UiPinnedItem[] = [];
  const seenPinnedProjectIds = new Set<ProjectId>();
  const seenPinnedThreadIds = new Set<ThreadId>();
  for (const item of state.pinnedItems) {
    if (item.kind === "thread") {
      if (seenPinnedThreadIds.has(item.id)) {
        continue;
      }
      seenPinnedThreadIds.add(item.id);
      nextPinnedItems.push(item);
      continue;
    }
    const matchedProjectId =
      (item.id in nextExpandedById ? item.id : undefined) ??
      (() => {
        const previousCwd = previousProjectCwdById.get(item.id);
        return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
      })();
    if (!matchedProjectId || seenPinnedProjectIds.has(matchedProjectId)) {
      continue;
    }
    seenPinnedProjectIds.add(matchedProjectId);
    nextPinnedItems.push({ kind: "project", id: matchedProjectId });
  }
  for (const project of mappedProjects) {
    if (!persistedPinnedProjectCwds.has(project.cwd) || seenPinnedProjectIds.has(project.id)) {
      continue;
    }
    seenPinnedProjectIds.add(project.id);
    nextPinnedItems.push({ kind: "project", id: project.id });
  }

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const usedProjectIds = new Set<ProjectId>();
          const orderedProjectIds: ProjectId[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (projectId in nextExpandedById ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  if (
    pinnedItemsEqual(state.pinnedItems, nextPinnedItems) &&
    threadOrdersByProjectEqual(state.threadOrderByProjectId, nextThreadOrderByProjectId) &&
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    pinnedItems: nextPinnedItems,
    threadOrderByProjectId: nextThreadOrderByProjectId,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
  };
}

export function syncThreads(state: UiState, threads: readonly SyncThreadInput[]): UiState {
  const retainedThreadIds = new Set(threads.map((thread) => thread.id));
  const threadProjectIdByThreadId = new Map<ThreadId, ProjectId>();
  for (const thread of threads) {
    if (thread.projectId) {
      threadProjectIdByThreadId.set(thread.id, thread.projectId);
    }
  }
  const nextThreadOrderByProjectId: Record<string, ThreadId[]> = {};
  for (const [projectId, order] of Object.entries(state.threadOrderByProjectId)) {
    const nextOrder = order.filter((threadId) => {
      if (!retainedThreadIds.has(threadId)) {
        return false;
      }
      const threadProjectId = threadProjectIdByThreadId.get(threadId);
      return !threadProjectId || threadProjectId === (projectId as ProjectId);
    });
    if (nextOrder.length > 0) {
      nextThreadOrderByProjectId[projectId] = nextOrder;
    }
  }
  for (const thread of threads) {
    if (!thread.projectId) {
      continue;
    }
    const projectOrder = nextThreadOrderByProjectId[thread.projectId] ?? [];
    if (!projectOrder.includes(thread.id)) {
      nextThreadOrderByProjectId[thread.projectId] = [...projectOrder, thread.id];
    } else if (projectOrder !== nextThreadOrderByProjectId[thread.projectId]) {
      nextThreadOrderByProjectId[thread.projectId] = projectOrder;
    }
  }
  const nextPinnedItems = state.pinnedItems.filter(
    (item) => item.kind === "project" || retainedThreadIds.has(item.id),
  );
  const nextPinnedThreadIds = new Set(
    nextPinnedItems.flatMap((item) => (item.kind === "thread" ? [item.id] : [])),
  );
  for (const threadId of persistedPinnedThreadIds) {
    const typedThreadId = threadId as ThreadId;
    if (retainedThreadIds.has(typedThreadId) && !nextPinnedThreadIds.has(typedThreadId)) {
      nextPinnedThreadIds.add(typedThreadId);
      nextPinnedItems.push({ kind: "thread", id: typedThreadId });
    }
  }
  const nextThreadLastVisitedAtById = Object.fromEntries(
    Object.entries(state.threadLastVisitedAtById).filter(([threadId]) =>
      retainedThreadIds.has(threadId as ThreadId),
    ),
  );
  const nextActiveThreadId =
    state.activeThreadId && retainedThreadIds.has(state.activeThreadId)
      ? state.activeThreadId
      : null;
  const nextPreviousActiveThreadId =
    state.previousActiveThreadId && retainedThreadIds.has(state.previousActiveThreadId)
      ? state.previousActiveThreadId
      : null;
  for (const thread of threads) {
    if (
      nextThreadLastVisitedAtById[thread.id] === undefined &&
      thread.seedVisitedAt !== undefined &&
      thread.seedVisitedAt.length > 0
    ) {
      nextThreadLastVisitedAtById[thread.id] = thread.seedVisitedAt;
    }
  }
  if (
    threadOrdersByProjectEqual(state.threadOrderByProjectId, nextThreadOrderByProjectId) &&
    recordsEqual(state.threadLastVisitedAtById, nextThreadLastVisitedAtById) &&
    pinnedItemsEqual(state.pinnedItems, nextPinnedItems)
  ) {
    return state.activeThreadId === nextActiveThreadId &&
      state.previousActiveThreadId === nextPreviousActiveThreadId
      ? state
      : {
          ...state,
          activeThreadId: nextActiveThreadId,
          previousActiveThreadId: nextPreviousActiveThreadId,
        };
  }
  return {
    ...state,
    pinnedItems: nextPinnedItems,
    threadOrderByProjectId: nextThreadOrderByProjectId,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    activeThreadId: nextActiveThreadId,
    previousActiveThreadId: nextPreviousActiveThreadId,
  };
}

export function trackActiveThread(state: UiState, threadId: ThreadId | null | undefined): UiState {
  const nextActiveThreadId = threadId ?? null;
  if (state.activeThreadId === nextActiveThreadId) {
    return state;
  }
  return {
    ...state,
    activeThreadId: nextActiveThreadId,
    previousActiveThreadId: state.activeThreadId,
  };
}

export function markThreadVisited(state: UiState, threadId: ThreadId, visitedAt?: string): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: at,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: ThreadId,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function clearThreadUi(state: UiState, threadId: ThreadId): UiState {
  persistedPinnedThreadIds.delete(threadId);
  const nextThreadOrderByProjectId: Record<string, ThreadId[]> = {};
  let threadOrderChanged = false;
  for (const [projectId, order] of Object.entries(state.threadOrderByProjectId)) {
    const nextOrder = order.filter((id) => id !== threadId);
    if (nextOrder.length === 0) {
      if (order.length > 0) {
        threadOrderChanged = true;
      }
      continue;
    }
    if (!threadOrdersEqual(order, nextOrder)) {
      threadOrderChanged = true;
    }
    nextThreadOrderByProjectId[projectId] = nextOrder;
  }
  if (
    !threadOrderChanged &&
    !state.pinnedItems.some((item) => item.kind === "thread" && item.id === threadId) &&
    !(threadId in state.threadLastVisitedAtById) &&
    state.activeThreadId !== threadId &&
    state.previousActiveThreadId !== threadId
  ) {
    return state;
  }
  const nextThreadLastVisitedAtById = { ...state.threadLastVisitedAtById };
  delete nextThreadLastVisitedAtById[threadId];
  return {
    ...state,
    pinnedItems: state.pinnedItems.filter(
      (item) => !(item.kind === "thread" && item.id === threadId),
    ),
    threadOrderByProjectId: nextThreadOrderByProjectId,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    activeThreadId: state.activeThreadId === threadId ? null : state.activeThreadId,
    previousActiveThreadId:
      state.previousActiveThreadId === threadId ? null : state.previousActiveThreadId,
  };
}

export function reorderThreadsInProject(
  state: UiState,
  projectId: ProjectId,
  draggedThreadId: ThreadId,
  targetThreadId: ThreadId,
): UiState {
  if (draggedThreadId === targetThreadId) {
    return state;
  }
  const projectOrder = state.threadOrderByProjectId[projectId] ?? [];
  const draggedIndex = projectOrder.findIndex((threadId) => threadId === draggedThreadId);
  const targetIndex = projectOrder.findIndex((threadId) => threadId === targetThreadId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return state;
  }
  const nextProjectOrder = [...projectOrder];
  const [draggedThread] = nextProjectOrder.splice(draggedIndex, 1);
  if (!draggedThread) {
    return state;
  }
  nextProjectOrder.splice(targetIndex, 0, draggedThread);
  if (threadOrdersEqual(projectOrder, nextProjectOrder)) {
    return state;
  }
  return {
    ...state,
    threadOrderByProjectId: {
      ...state.threadOrderByProjectId,
      [projectId]: nextProjectOrder,
    },
  };
}

export function togglePinnedProject(state: UiState, projectId: ProjectId): UiState {
  const projectCwd = currentProjectCwdById.get(projectId);
  if (state.pinnedItems.some((item) => item.kind === "project" && item.id === projectId)) {
    if (projectCwd) {
      persistedPinnedProjectCwds.delete(projectCwd);
    }
    return {
      ...state,
      pinnedItems: state.pinnedItems.filter(
        (item) => !(item.kind === "project" && item.id === projectId),
      ),
    };
  }

  if (projectCwd) {
    persistedPinnedProjectCwds.add(projectCwd);
  }
  return {
    ...state,
    pinnedItems: [...state.pinnedItems, { kind: "project", id: projectId }],
  };
}

export function togglePinnedThread(state: UiState, threadId: ThreadId): UiState {
  if (state.pinnedItems.some((item) => item.kind === "thread" && item.id === threadId)) {
    persistedPinnedThreadIds.delete(threadId);
    return {
      ...state,
      pinnedItems: state.pinnedItems.filter(
        (item) => !(item.kind === "thread" && item.id === threadId),
      ),
    };
  }

  persistedPinnedThreadIds.add(threadId);
  return {
    ...state,
    pinnedItems: [...state.pinnedItems, { kind: "thread", id: threadId }],
  };
}

export function reorderPinnedThreads(
  state: UiState,
  draggedThreadId: ThreadId,
  targetThreadId: ThreadId,
): UiState {
  if (draggedThreadId === targetThreadId) {
    return state;
  }
  const draggedIndex = state.pinnedItems.findIndex(
    (item) => item.kind === "thread" && item.id === draggedThreadId,
  );
  const targetIndex = state.pinnedItems.findIndex(
    (item) => item.kind === "thread" && item.id === targetThreadId,
  );
  if (draggedIndex < 0 || targetIndex < 0) {
    return state;
  }
  const pinnedItems = [...state.pinnedItems];
  const [draggedThread] = pinnedItems.splice(draggedIndex, 1);
  if (!draggedThread) {
    return state;
  }
  pinnedItems.splice(targetIndex, 0, draggedThread);
  if (pinnedItemsEqual(state.pinnedItems, pinnedItems)) {
    return state;
  }
  return {
    ...state,
    pinnedItems,
  };
}

export function toggleProject(state: UiState, projectId: ProjectId): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(
  state: UiState,
  projectId: ProjectId,
  expanded: boolean,
): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function setPinnedSectionExpanded(state: UiState, expanded: boolean): UiState {
  if (state.pinnedSectionExpanded === expanded) {
    return state;
  }
  return {
    ...state,
    pinnedSectionExpanded: expanded,
  };
}

export function setProjectsSectionExpanded(state: UiState, expanded: boolean): UiState {
  if (state.projectsSectionExpanded === expanded) {
    return state;
  }
  return {
    ...state,
    projectsSectionExpanded: expanded,
  };
}

export function setBoardsSectionExpanded(state: UiState, expanded: boolean): UiState {
  if (state.boardsSectionExpanded === expanded) {
    return state;
  }
  return {
    ...state,
    boardsSectionExpanded: expanded,
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectId: ProjectId,
  targetProjectId: ProjectId,
): UiState {
  if (draggedProjectId === targetProjectId) {
    return state;
  }
  const draggedIndex = state.projectOrder.findIndex((projectId) => projectId === draggedProjectId);
  const targetIndex = state.projectOrder.findIndex((projectId) => projectId === targetProjectId);
  if (draggedIndex < 0 || targetIndex < 0) {
    return state;
  }
  const projectOrder = [...state.projectOrder];
  const [draggedProject] = projectOrder.splice(draggedIndex, 1);
  if (!draggedProject) {
    return state;
  }
  projectOrder.splice(targetIndex, 0, draggedProject);
  return {
    ...state,
    projectOrder,
  };
}

interface UiStateStore extends UiState {
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  trackActiveThread: (threadId: ThreadId | null | undefined) => void;
  markThreadVisited: (threadId: ThreadId, visitedAt?: string) => void;
  markThreadUnread: (threadId: ThreadId, latestTurnCompletedAt: string | null | undefined) => void;
  clearThreadUi: (threadId: ThreadId) => void;
  reorderThreadsInProject: (
    projectId: ProjectId,
    draggedThreadId: ThreadId,
    targetThreadId: ThreadId,
  ) => void;
  reorderPinnedThreads: (draggedThreadId: ThreadId, targetThreadId: ThreadId) => void;
  togglePinnedProject: (projectId: ProjectId) => void;
  togglePinnedThread: (threadId: ThreadId) => void;
  toggleProject: (projectId: ProjectId) => void;
  setProjectExpanded: (projectId: ProjectId, expanded: boolean) => void;
  setPinnedSectionExpanded: (expanded: boolean) => void;
  setProjectsSectionExpanded: (expanded: boolean) => void;
  setBoardsSectionExpanded: (expanded: boolean) => void;
  reorderProjects: (draggedProjectId: ProjectId, targetProjectId: ProjectId) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncThreads: (threads) => set((state) => syncThreads(state, threads)),
  trackActiveThread: (threadId) => set((state) => trackActiveThread(state, threadId)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  clearThreadUi: (threadId) => set((state) => clearThreadUi(state, threadId)),
  reorderThreadsInProject: (projectId, draggedThreadId, targetThreadId) =>
    set((state) => reorderThreadsInProject(state, projectId, draggedThreadId, targetThreadId)),
  reorderPinnedThreads: (draggedThreadId, targetThreadId) =>
    set((state) => reorderPinnedThreads(state, draggedThreadId, targetThreadId)),
  togglePinnedProject: (projectId) => set((state) => togglePinnedProject(state, projectId)),
  togglePinnedThread: (threadId) => set((state) => togglePinnedThread(state, threadId)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  setPinnedSectionExpanded: (expanded) => set((state) => setPinnedSectionExpanded(state, expanded)),
  setProjectsSectionExpanded: (expanded) =>
    set((state) => setProjectsSectionExpanded(state, expanded)),
  setBoardsSectionExpanded: (expanded) => set((state) => setBoardsSectionExpanded(state, expanded)),
  reorderProjects: (draggedProjectId, targetProjectId) =>
    set((state) => reorderProjects(state, draggedProjectId, targetProjectId)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
