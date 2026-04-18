import {
  ProjectId,
  ThreadId,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
} from "@ace/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Project, SidebarThreadSummary } from "../../types";
import type {
  CombinedSidebarSnapshot,
  CombinedSidebarSnapshotProject,
  CombinedSidebarSnapshotThread,
  RemoteSidebarHostEntry,
  RemoteSidebarProjectEntry,
  SearchPaletteItem,
  SearchPaletteMode,
} from "./sidebarTypes";

function resolveIsoTimestamp(input: string | undefined): number {
  if (!input) {
    return 0;
  }
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortByUpdatedAtDescending<T extends { readonly updatedAt: string }>(
  entries: ReadonlyArray<T>,
): T[] {
  return [...entries].toSorted((left, right) => {
    return resolveIsoTimestamp(right.updatedAt) - resolveIsoTimestamp(left.updatedAt);
  });
}

interface UseSidebarCommandPaletteInput {
  readonly sortedProjects: ReadonlyArray<Project>;
  readonly visibleProjectThreadsByProjectId: ReadonlyMap<
    ProjectId,
    ReadonlyArray<SidebarThreadSummary>
  >;
  readonly remoteSidebarHosts: ReadonlyArray<RemoteSidebarHostEntry>;
  readonly sortedActiveThreads: ReadonlyArray<SidebarThreadSummary>;
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly activeWsUrl: string;
  readonly localDeviceConnectionUrl: string;
  readonly threadIdsByProjectId: Readonly<Record<ProjectId, readonly ThreadId[] | undefined>>;
  readonly projectSortOrder: SidebarProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onStartAddProject: () => void;
  readonly onStartNewThreadForProject: (projectId: ProjectId) => void;
  readonly onStartNewThreadForRemoteProject: (input: {
    connectionUrl: string;
    project: RemoteSidebarProjectEntry;
  }) => void;
  readonly onFocusMostRecentThreadForProject: (projectId: ProjectId) => void;
  readonly onNavigateSettings: () => void;
  readonly onNavigateToThread: (threadId: ThreadId) => void;
  readonly onNavigateToThreadOnConnection: (connectionUrl: string, threadId: ThreadId) => void;
}

interface UseSidebarCommandPaletteResult {
  readonly searchPaletteOpen: boolean;
  readonly searchPaletteMode: SearchPaletteMode;
  readonly searchPaletteQuery: string;
  readonly searchPaletteActiveIndex: number;
  readonly searchPaletteInputRef: React.RefObject<HTMLInputElement | null>;
  readonly normalizedSearchPaletteQuery: string;
  readonly searchPaletteItems: ReadonlyArray<SearchPaletteItem>;
  readonly searchPaletteActionItems: ReadonlyArray<SearchPaletteItem>;
  readonly searchPaletteProjectItems: ReadonlyArray<SearchPaletteItem>;
  readonly searchPaletteThreadItems: ReadonlyArray<SearchPaletteItem>;
  readonly searchPaletteIndexById: ReadonlyMap<string, number>;
  readonly openSearchPalette: () => void;
  readonly closeSearchPalette: () => void;
  readonly handleSearchPaletteOpenChange: (open: boolean) => void;
  readonly handleSearchPaletteBack: () => void;
  readonly handleSearchPaletteQueryChange: (value: string) => void;
  readonly handleSearchPaletteItemHover: (itemId: string) => void;
  readonly handleSearchPaletteInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly handleSearchPaletteSelect: (item: SearchPaletteItem) => void;
}

export function useSidebarCommandPalette(
  input: UseSidebarCommandPaletteInput,
): UseSidebarCommandPaletteResult {
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [searchPaletteMode, setSearchPaletteMode] = useState<SearchPaletteMode>("root");
  const [searchPaletteQuery, setSearchPaletteQuery] = useState("");
  const [searchPaletteActiveIndex, setSearchPaletteActiveIndex] = useState(-1);
  const searchPaletteInputRef = useRef<HTMLInputElement | null>(null);

  const combinedSidebarSnapshot = useMemo<CombinedSidebarSnapshot>(() => {
    const localProjectSnapshots: CombinedSidebarSnapshotProject[] = input.sortedProjects.map(
      (project) => {
        const threads = sortByUpdatedAtDescending(
          (input.visibleProjectThreadsByProjectId.get(project.id) ?? []).map((thread) => ({
            id: thread.id,
            title: thread.title,
            updatedAt: thread.updatedAt ?? thread.createdAt,
            lastUserMessageAt: thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt ?? "",
          })),
        );
        const lastUserMessageAt =
          threads.length > 0 && threads.some((t) => t.lastUserMessageAt)
            ? threads.find((t) => t.lastUserMessageAt)?.lastUserMessageAt ?? ""
            : "";
        return {
          id: project.id,
          name: project.name,
          cwd: project.cwd,
          updatedAt: project.updatedAt ?? threads[0]?.updatedAt ?? project.createdAt ?? "",
          lastUserMessageAt: lastUserMessageAt,
          icon: project.icon,
          defaultModelSelection: project.defaultModelSelection,
          connectionUrl: input.activeWsUrl,
          threads,
        };
      },
    );
    const resolveProjectSortTimestamp = (
      project: CombinedSidebarSnapshotProject,
      sortOrder: SidebarProjectSortOrder,
    ): number => {
      if (sortOrder === "created_at") {
        return resolveIsoTimestamp(project.updatedAt);
      }
      if (sortOrder === "last_user_message") {
        return resolveIsoTimestamp(project.lastUserMessageAt);
      }
      return resolveIsoTimestamp(project.updatedAt);
    };

    const resolveThreadSortTimestamp = (
      thread: CombinedSidebarSnapshotThread,
      sortOrder: SidebarThreadSortOrder,
    ): number => {
      if (sortOrder === "created_at") {
        return resolveIsoTimestamp(thread.updatedAt);
      }
      if (sortOrder === "last_user_message") {
        return resolveIsoTimestamp(thread.lastUserMessageAt);
      }
      return resolveIsoTimestamp(thread.updatedAt);
    };

    const remoteProjectSnapshots: CombinedSidebarSnapshotProject[] = input.remoteSidebarHosts
      .filter((entry) => entry.status === "available")
      .flatMap((entry) =>
        entry.projects.map((project) => ({
          id: project.id,
          name: project.name,
          cwd: project.cwd,
          updatedAt: project.updatedAt,
          lastUserMessageAt: project.lastUserMessageAt,
          icon: project.icon,
          defaultModelSelection: project.defaultModelSelection,
          connectionUrl: entry.connectionUrl,
          threads: project.threads,
        })),
      );
    const projects = [...localProjectSnapshots, ...remoteProjectSnapshots].toSorted((left, right) => {
      const leftTs = resolveProjectSortTimestamp(left, input.projectSortOrder);
      const rightTs = resolveProjectSortTimestamp(right, input.projectSortOrder);
      if (rightTs !== leftTs) {
        return rightTs - leftTs;
      }
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) {
        return byName;
      }
      return `${left.connectionUrl}:${left.id}`.localeCompare(
        `${right.connectionUrl}:${right.id}`,
      );
    });
    const localThreads: CombinedSidebarSnapshotThread[] = input.sortedActiveThreads.map(
      (thread) => {
        const parentProject = input.projectById.get(thread.projectId);
        const lastUserMessageAt = thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
        return {
          id: thread.id,
          title: thread.title,
          description: parentProject?.name ?? thread.worktreePath ?? thread.branch ?? "Thread",
          updatedAt: thread.updatedAt,
          lastUserMessageAt,
          connectionUrl: input.activeWsUrl,
        };
      },
    );
    const remoteThreads: CombinedSidebarSnapshotThread[] = remoteProjectSnapshots.flatMap(
      (project) =>
        project.threads.map((thread) => ({
          id: ThreadId.makeUnsafe(thread.id),
          title: thread.title,
          description: project.name,
          updatedAt: thread.updatedAt,
          lastUserMessageAt: thread.lastUserMessageAt,
          connectionUrl: project.connectionUrl,
        })),
    );
    const threads = [...localThreads, ...remoteThreads].toSorted((left, right) => {
      const leftTs = resolveThreadSortTimestamp(left, input.threadSortOrder);
      const rightTs = resolveThreadSortTimestamp(right, input.threadSortOrder);
      return rightTs - leftTs;
    });
    return {
      projects,
      threads,
    };
  }, [
    input.activeWsUrl,
    input.projectById,
    input.projectSortOrder,
    input.remoteSidebarHosts,
    input.sortedActiveThreads,
    input.sortedProjects,
    input.threadSortOrder,
    input.visibleProjectThreadsByProjectId,
  ]);

  const normalizedSearchPaletteQuery = searchPaletteQuery.trim().toLowerCase();
  const searchPaletteItems = useMemo<SearchPaletteItem[]>(() => {
    const actionItems: SearchPaletteItem[] = [
      {
        id: "action-new-thread",
        type: "action.new-thread",
        label: "New thread in...",
        description: "Choose a project for a new thread.",
      },
      {
        id: "action-new-project",
        type: "action.new-project",
        label: "New project",
        description: "Open project picker.",
      },
      {
        id: "action-open-settings",
        type: "action.open-settings",
        label: "Open settings",
        description: "Settings",
      },
    ];

    const allProjectItems = combinedSidebarSnapshot.projects.map((project): SearchPaletteItem => {
      const isLocalProject = project.connectionUrl === input.localDeviceConnectionUrl;
      return {
        id: `project:${project.connectionUrl}:${project.id}`,
        type: "project",
        projectId: project.id,
        label: project.name,
        description: project.cwd,
        ...(isLocalProject ? {} : { connectionUrl: project.connectionUrl }),
      };
    });
    const recentProjectItems = allProjectItems.slice(0, 8);
    const threadItems = combinedSidebarSnapshot.threads.map((thread): SearchPaletteItem => {
      const isLocalThread = thread.connectionUrl === input.localDeviceConnectionUrl;
      return {
        id: `thread:${thread.connectionUrl}:${thread.id}`,
        type: "thread",
        threadId: thread.id,
        label: thread.title,
        description: thread.description,
        ...(isLocalThread ? {} : { connectionUrl: thread.connectionUrl }),
      };
    });

    const matchesQuery = (value: string): boolean =>
      value.toLowerCase().includes(normalizedSearchPaletteQuery);

    if (searchPaletteMode === "new-thread-project") {
      if (normalizedSearchPaletteQuery.length === 0) {
        return allProjectItems.slice(0, 12);
      }
      return allProjectItems
        .filter((item) => matchesQuery(item.label) || matchesQuery(item.description))
        .slice(0, 24);
    }

    if (normalizedSearchPaletteQuery.length === 0) {
      return [...actionItems, ...recentProjectItems, ...threadItems.slice(0, 8)];
    }

    const matchedActions = actionItems.filter(
      (item) => matchesQuery(item.label) || matchesQuery(item.description),
    );
    const matchedProjects = allProjectItems.filter(
      (item) => matchesQuery(item.label) || matchesQuery(item.description),
    );
    const matchedThreads = threadItems.filter(
      (item) => matchesQuery(item.label) || matchesQuery(item.description),
    );
    return [...matchedActions, ...matchedProjects, ...matchedThreads].slice(0, 40);
  }, [
    combinedSidebarSnapshot,
    input.localDeviceConnectionUrl,
    normalizedSearchPaletteQuery,
    searchPaletteMode,
  ]);

  const searchPaletteActionItems = useMemo(
    () =>
      searchPaletteItems.filter(
        (item) =>
          item.type === "action.new-thread" ||
          item.type === "action.new-project" ||
          item.type === "action.open-settings",
      ),
    [searchPaletteItems],
  );
  const searchPaletteProjectItems = useMemo(
    () => searchPaletteItems.filter((item) => item.type === "project"),
    [searchPaletteItems],
  );
  const searchPaletteThreadItems = useMemo(
    () => searchPaletteItems.filter((item) => item.type === "thread"),
    [searchPaletteItems],
  );
  const searchPaletteIndexById = useMemo(
    () => new Map(searchPaletteItems.map((item, index) => [item.id, index] as const)),
    [searchPaletteItems],
  );

  const openSearchPalette = useCallback(() => {
    setSearchPaletteMode("root");
    setSearchPaletteQuery("");
    setSearchPaletteActiveIndex(-1);
    setSearchPaletteOpen(true);
  }, []);

  const closeSearchPalette = useCallback(() => {
    setSearchPaletteOpen(false);
    setSearchPaletteMode("root");
    setSearchPaletteQuery("");
    setSearchPaletteActiveIndex(-1);
  }, []);

  const handleSearchPaletteBack = useCallback(() => {
    setSearchPaletteMode("root");
    setSearchPaletteQuery("");
    setSearchPaletteActiveIndex(0);
  }, []);

  const handleSearchPaletteQueryChange = useCallback((value: string) => {
    setSearchPaletteQuery(value);
    setSearchPaletteActiveIndex(0);
  }, []);
  const handleSearchPaletteItemHover = useCallback(
    (itemId: string) => {
      const index = searchPaletteIndexById.get(itemId);
      if (index !== undefined) {
        setSearchPaletteActiveIndex(index);
      }
    },
    [searchPaletteIndexById],
  );

  const handleSearchPaletteSelect = useCallback(
    (item: SearchPaletteItem) => {
      if (item.type === "action.new-thread") {
        setSearchPaletteMode("new-thread-project");
        setSearchPaletteQuery("");
        setSearchPaletteActiveIndex(0);
        return;
      }
      if (item.type === "action.new-project") {
        closeSearchPalette();
        input.onStartAddProject();
        return;
      }
      if (item.type === "action.open-settings") {
        closeSearchPalette();
        input.onNavigateSettings();
        return;
      }
      if (item.type === "project") {
        const isRemoteProject =
          item.connectionUrl !== undefined && item.connectionUrl !== input.activeWsUrl;
        closeSearchPalette();
        if (searchPaletteMode === "new-thread-project") {
          if (isRemoteProject && item.connectionUrl) {
            const remoteProject = input.remoteSidebarHosts
              .find((entry) => entry.connectionUrl === item.connectionUrl)
              ?.projects.find((project) => project.id === item.projectId);
            if (!remoteProject) {
              return;
            }
            input.onStartNewThreadForRemoteProject({
              connectionUrl: item.connectionUrl,
              project: remoteProject,
            });
            return;
          }
          input.onStartNewThreadForProject(item.projectId);
          return;
        }
        if (isRemoteProject && item.connectionUrl) {
          const remoteProject = input.remoteSidebarHosts
            .find((entry) => entry.connectionUrl === item.connectionUrl)
            ?.projects.find((project) => project.id === item.projectId);
          const latestThread = remoteProject?.threads[0];
          if (latestThread) {
            input.onNavigateToThreadOnConnection(
              item.connectionUrl,
              ThreadId.makeUnsafe(latestThread.id),
            );
            return;
          }
          if (remoteProject) {
            input.onStartNewThreadForRemoteProject({
              connectionUrl: item.connectionUrl,
              project: remoteProject,
            });
          }
          return;
        }
        const projectThreadIds = input.threadIdsByProjectId[item.projectId] ?? [];
        if (projectThreadIds.length === 0) {
          input.onStartNewThreadForProject(item.projectId);
          return;
        }
        input.onFocusMostRecentThreadForProject(item.projectId);
        return;
      }
      closeSearchPalette();
      if (item.connectionUrl && item.connectionUrl !== input.activeWsUrl) {
        input.onNavigateToThreadOnConnection(item.connectionUrl, item.threadId);
        return;
      }
      input.onNavigateToThread(item.threadId);
    },
    [closeSearchPalette, input, searchPaletteMode],
  );

  const handleSearchPaletteInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSearchPaletteActiveIndex((currentIndex) => {
          if (searchPaletteItems.length === 0) {
            return -1;
          }
          return Math.min(currentIndex + 1, searchPaletteItems.length - 1);
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSearchPaletteActiveIndex((currentIndex) => {
          if (searchPaletteItems.length === 0) {
            return -1;
          }
          return currentIndex <= 0 ? 0 : currentIndex - 1;
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selectedItem =
          searchPaletteActiveIndex >= 0
            ? searchPaletteItems[searchPaletteActiveIndex]
            : searchPaletteItems[0];
        if (selectedItem) {
          handleSearchPaletteSelect(selectedItem);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearchPalette();
        return;
      }
      if (
        event.key === "Backspace" &&
        searchPaletteMode === "new-thread-project" &&
        searchPaletteQuery.trim().length === 0
      ) {
        event.preventDefault();
        setSearchPaletteMode("root");
      }
    },
    [
      closeSearchPalette,
      handleSearchPaletteSelect,
      searchPaletteActiveIndex,
      searchPaletteItems,
      searchPaletteMode,
      searchPaletteQuery,
    ],
  );

  const handleSearchPaletteOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeSearchPalette();
        return;
      }
      openSearchPalette();
    },
    [closeSearchPalette, openSearchPalette],
  );

  useEffect(() => {
    if (!searchPaletteOpen) {
      return;
    }
    searchPaletteInputRef.current?.focus();
  }, [searchPaletteOpen]);

  useEffect(() => {
    if (!searchPaletteOpen) {
      setSearchPaletteActiveIndex(-1);
      return;
    }
    setSearchPaletteActiveIndex((currentIndex) => {
      if (searchPaletteItems.length === 0) {
        return -1;
      }
      if (currentIndex < 0) {
        return 0;
      }
      return Math.min(currentIndex, searchPaletteItems.length - 1);
    });
  }, [searchPaletteItems, searchPaletteOpen]);

  return {
    searchPaletteOpen,
    searchPaletteMode,
    searchPaletteQuery,
    searchPaletteActiveIndex,
    searchPaletteInputRef,
    normalizedSearchPaletteQuery,
    searchPaletteItems,
    searchPaletteActionItems,
    searchPaletteProjectItems,
    searchPaletteThreadItems,
    searchPaletteIndexById,
    openSearchPalette,
    closeSearchPalette,
    handleSearchPaletteOpenChange,
    handleSearchPaletteBack,
    handleSearchPaletteQueryChange,
    handleSearchPaletteItemHover,
    handleSearchPaletteInputKeyDown,
    handleSearchPaletteSelect,
  };
}
