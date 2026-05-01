import { type SidebarProjectSortOrder, type SidebarThreadSortOrder } from "@ace/contracts/settings";
import { type ThreadId } from "@ace/contracts";

import { type SidebarThreadSummary } from "../../types";
import {
  getVisibleThreadsForProject,
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  sortThreadsForSidebar,
} from "../../lib/sidebar";

export const EMPTY_SIDEBAR_THREADS: readonly SidebarThreadSummary[] = [];

const sortedSidebarThreadsCache = new WeakMap<
  ReadonlyArray<SidebarThreadSummary>,
  Map<SidebarThreadSortOrder, SidebarThreadSummary[]>
>();
const threadStatusCache = new WeakMap<
  SidebarThreadSummary,
  Map<string, ReturnType<typeof resolveThreadStatusPill>>
>();
const projectStatusCache = new WeakMap<
  Record<string, string>,
  WeakMap<ReadonlyArray<SidebarThreadSummary>, ReturnType<typeof resolveProjectStatusIndicator>>
>();
const hiddenThreadStatusCache = new WeakMap<
  Record<string, string>,
  WeakMap<
    ReadonlyArray<SidebarThreadSummary>,
    Map<string, ReturnType<typeof resolveProjectStatusIndicator>>
  >
>();

export interface SidebarLocalProjectThreadGroup {
  readonly canCollapseThreadList: boolean;
  readonly hasHiddenThreads: boolean;
  readonly hiddenThreadCount: number;
  readonly orderedProjectThreadIds: readonly ThreadId[];
  readonly projectExpanded: boolean;
  readonly renderedThreadIds: readonly ThreadId[];
  readonly shouldShowThreadPanel: boolean;
  readonly showEmptyThreadState: boolean;
}

export interface SidebarLocalProjectRenderState extends SidebarLocalProjectThreadGroup {
  readonly hiddenThreadStatus: ReturnType<typeof resolveProjectStatusIndicator>;
  readonly projectStatus: ReturnType<typeof resolveProjectStatusIndicator>;
}

function getCachedSortedSidebarThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  sortOrder: SidebarThreadSortOrder,
): SidebarThreadSummary[] {
  let cacheBySortOrder = sortedSidebarThreadsCache.get(threads);
  if (!cacheBySortOrder) {
    cacheBySortOrder = new Map();
    sortedSidebarThreadsCache.set(threads, cacheBySortOrder);
  }

  const cachedThreads = cacheBySortOrder.get(sortOrder);
  if (cachedThreads) {
    return cachedThreads;
  }

  const sortedThreads = sortThreadsForSidebar(threads, sortOrder);
  cacheBySortOrder.set(sortOrder, sortedThreads);
  return sortedThreads;
}

function getCachedThreadStatus(
  thread: SidebarThreadSummary,
  lastVisitedAt: string | undefined,
): ReturnType<typeof resolveThreadStatusPill> {
  let cacheByVisitedAt = threadStatusCache.get(thread);
  if (!cacheByVisitedAt) {
    cacheByVisitedAt = new Map();
    threadStatusCache.set(thread, cacheByVisitedAt);
  }

  const cacheKey = lastVisitedAt ?? "";
  if (cacheByVisitedAt.has(cacheKey)) {
    return cacheByVisitedAt.get(cacheKey) ?? null;
  }

  const status = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  cacheByVisitedAt.set(cacheKey, status);
  return status;
}

function getCachedProjectStatus(
  threads: ReadonlyArray<SidebarThreadSummary>,
  threadLastVisitedAtById: Record<string, string>,
): ReturnType<typeof resolveProjectStatusIndicator> {
  let cacheByThreads = projectStatusCache.get(threadLastVisitedAtById);
  if (!cacheByThreads) {
    cacheByThreads = new WeakMap();
    projectStatusCache.set(threadLastVisitedAtById, cacheByThreads);
  }

  if (cacheByThreads.has(threads)) {
    return cacheByThreads.get(threads) ?? null;
  }

  const status = resolveProjectStatusIndicator(
    threads.map((thread) => getCachedThreadStatus(thread, threadLastVisitedAtById[thread.id])),
  );
  cacheByThreads.set(threads, status);
  return status;
}

function getCachedHiddenThreadStatus(input: {
  activeThreadId: ThreadId | undefined;
  visibleCount: number;
  threadLastVisitedAtById: Record<string, string>;
  threads: ReadonlyArray<SidebarThreadSummary>;
}): ReturnType<typeof resolveProjectStatusIndicator> {
  if (input.threads.length <= input.visibleCount) {
    return null;
  }

  let cacheByThreads = hiddenThreadStatusCache.get(input.threadLastVisitedAtById);
  if (!cacheByThreads) {
    cacheByThreads = new WeakMap();
    hiddenThreadStatusCache.set(input.threadLastVisitedAtById, cacheByThreads);
  }

  let cacheByKey = cacheByThreads.get(input.threads);
  if (!cacheByKey) {
    cacheByKey = new Map();
    cacheByThreads.set(input.threads, cacheByKey);
  }

  const cacheKey = `${input.activeThreadId ?? ""}:${input.visibleCount}`;
  if (cacheByKey.has(cacheKey)) {
    return cacheByKey.get(cacheKey) ?? null;
  }

  const { hiddenThreads } = getVisibleThreadsForProject({
    threads: input.threads,
    activeThreadId: input.activeThreadId,
    visibleCount: input.visibleCount,
  });
  const status = resolveProjectStatusIndicator(
    hiddenThreads.map((thread) =>
      getCachedThreadStatus(thread, input.threadLastVisitedAtById[thread.id]),
    ),
  );
  cacheByKey.set(cacheKey, status);
  return status;
}

export function deriveSidebarLocalProjectThreadGroup(input: {
  activeThreadId: ThreadId | undefined;
  projectExpanded: boolean;
  projectListThreads: ReadonlyArray<SidebarThreadSummary>;
  revealStep: number;
  unsortedProjectThreads: ReadonlyArray<SidebarThreadSummary>;
  visibleThreadCount: number;
  threadSortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">;
}): SidebarLocalProjectThreadGroup {
  const projectThreads = getCachedSortedSidebarThreads(
    input.projectListThreads,
    input.threadSortOrder,
  );
  const collapsedPreviewThread = !input.projectExpanded
    ? ((input.activeThreadId
        ? (projectThreads.find((thread) => thread.id === input.activeThreadId) ?? null)
        : null) ?? null)
    : null;
  const shouldShowThreadPanel = input.projectExpanded || collapsedPreviewThread !== null;
  const { hasHiddenThreads, hiddenThreads, visibleThreads } = shouldShowThreadPanel
    ? getVisibleThreadsForProject({
        threads: projectThreads,
        activeThreadId: input.activeThreadId,
        visibleCount: input.visibleThreadCount,
      })
    : {
        hasHiddenThreads: false,
        hiddenThreads: EMPTY_SIDEBAR_THREADS,
        visibleThreads: EMPTY_SIDEBAR_THREADS,
      };
  const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);
  const renderedThreadIds = collapsedPreviewThread
    ? [collapsedPreviewThread.id]
    : visibleThreads.map((thread) => thread.id);

  return {
    canCollapseThreadList: input.visibleThreadCount > input.revealStep,
    hasHiddenThreads,
    hiddenThreadCount: hiddenThreads.length,
    orderedProjectThreadIds,
    projectExpanded: input.projectExpanded,
    renderedThreadIds,
    shouldShowThreadPanel,
    showEmptyThreadState: input.projectExpanded && input.unsortedProjectThreads.length === 0,
  };
}

export function deriveSidebarLocalProjectRenderState(input: {
  activeThreadId: ThreadId | undefined;
  projectExpanded: boolean;
  projectListThreads: ReadonlyArray<SidebarThreadSummary>;
  revealStep: number;
  threadLastVisitedAtById: Record<string, string>;
  unsortedProjectThreads: ReadonlyArray<SidebarThreadSummary>;
  visibleThreadCount: number;
  threadSortOrder: SidebarThreadSortOrder;
}): SidebarLocalProjectRenderState {
  const threadGroup = deriveSidebarLocalProjectThreadGroup(input);
  return {
    ...threadGroup,
    hiddenThreadStatus:
      input.projectExpanded && threadGroup.hasHiddenThreads
        ? getCachedHiddenThreadStatus({
            activeThreadId: input.activeThreadId,
            visibleCount: input.visibleThreadCount,
            threadLastVisitedAtById: input.threadLastVisitedAtById,
            threads: input.projectListThreads,
          })
        : null,
    projectStatus: getCachedProjectStatus(
      input.unsortedProjectThreads,
      input.threadLastVisitedAtById,
    ),
  };
}
