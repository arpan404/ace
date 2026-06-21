import {
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type ProjectId,
  type ThreadId,
} from "@ace/contracts";
import { normalizeWsUrl } from "@ace/shared/hostConnections";
import { create } from "zustand";

interface ConnectionOwnership {
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

interface HostConnectionState {
  readonly projectConnectionById: Record<string, string>;
  readonly threadConnectionById: Record<string, string>;
  readonly ownershipByConnectionUrl: Record<string, ConnectionOwnership>;
  readonly getOwnership: (connectionUrl: string) => ConnectionOwnership | undefined;
  readonly mergeSnapshotOwnership: (
    connectionUrl: string,
    snapshot: ConnectionOwnershipSnapshot,
  ) => void;
  readonly upsertSnapshotOwnership: (
    connectionUrl: string,
    snapshot: ConnectionOwnershipSnapshot,
  ) => void;
  readonly upsertProjectOwnership: (connectionUrl: string, projectId: ProjectId) => void;
  readonly upsertThreadOwnership: (connectionUrl: string, threadId: ThreadId) => void;
  readonly removeConnection: (connectionUrl: string) => void;
}

type ConnectionOwnershipSnapshot = OrchestrationReadModel | OrchestrationShellSnapshot;

function resolveSnapshotOwnership(snapshot: ConnectionOwnershipSnapshot): ConnectionOwnership {
  const projectIds: ProjectId[] = [];
  for (const project of snapshot.projects) {
    if (project.deletedAt === null && project.archivedAt === null) {
      projectIds.push(project.id);
    }
  }
  const threadIds: ThreadId[] = [];
  for (const thread of snapshot.threads) {
    if (thread.deletedAt === null && thread.archivedAt === null) {
      threadIds.push(thread.id);
    }
  }
  return {
    projectIds,
    threadIds,
  };
}

function removeConnectionMappings(
  projectConnectionById: Record<string, string>,
  threadConnectionById: Record<string, string>,
  ownership: ConnectionOwnership,
  normalizedConnectionUrl: string,
) {
  const nextProjectConnectionById = { ...projectConnectionById };
  for (const projectId of ownership.projectIds) {
    if (nextProjectConnectionById[projectId] === normalizedConnectionUrl) {
      delete nextProjectConnectionById[projectId];
    }
  }

  const nextThreadConnectionById = { ...threadConnectionById };
  for (const threadId of ownership.threadIds) {
    if (nextThreadConnectionById[threadId] === normalizedConnectionUrl) {
      delete nextThreadConnectionById[threadId];
    }
  }

  return {
    nextProjectConnectionById,
    nextThreadConnectionById,
  };
}

function removeOwnershipConflicts(
  ownershipByConnectionUrl: Record<string, ConnectionOwnership>,
  normalizedConnectionUrl: string,
  ownership: ConnectionOwnership,
): Record<string, ConnectionOwnership> {
  const projectIds = new Set(ownership.projectIds);
  const threadIds = new Set(ownership.threadIds);
  if (projectIds.size === 0 && threadIds.size === 0) {
    return ownershipByConnectionUrl;
  }

  let changed = false;
  const nextOwnershipByConnectionUrl: Record<string, ConnectionOwnership> = {};
  for (const [connectionUrl, existingOwnership] of Object.entries(ownershipByConnectionUrl)) {
    if (connectionUrl === normalizedConnectionUrl) {
      nextOwnershipByConnectionUrl[connectionUrl] = existingOwnership;
      continue;
    }

    const nextProjectIds = existingOwnership.projectIds.filter(
      (projectId) => !projectIds.has(projectId),
    );
    const nextThreadIds = existingOwnership.threadIds.filter(
      (threadId) => !threadIds.has(threadId),
    );
    if (
      nextProjectIds.length !== existingOwnership.projectIds.length ||
      nextThreadIds.length !== existingOwnership.threadIds.length
    ) {
      changed = true;
      nextOwnershipByConnectionUrl[connectionUrl] = {
        projectIds: nextProjectIds,
        threadIds: nextThreadIds,
      };
      continue;
    }
    nextOwnershipByConnectionUrl[connectionUrl] = existingOwnership;
  }

  return changed ? nextOwnershipByConnectionUrl : ownershipByConnectionUrl;
}

function mergeOwnership(
  existingOwnership: ConnectionOwnership | undefined,
  incomingOwnership: ConnectionOwnership,
): ConnectionOwnership {
  return {
    projectIds: Array.from(
      new Set([...(existingOwnership?.projectIds ?? []), ...incomingOwnership.projectIds]),
    ),
    threadIds: Array.from(
      new Set([...(existingOwnership?.threadIds ?? []), ...incomingOwnership.threadIds]),
    ),
  };
}

export const useHostConnectionStore = create<HostConnectionState>((set, get) => ({
  projectConnectionById: {},
  threadConnectionById: {},
  ownershipByConnectionUrl: {},
  getOwnership: (connectionUrl) => {
    const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
    return get().ownershipByConnectionUrl[normalizedConnectionUrl];
  },
  mergeSnapshotOwnership: (connectionUrl, snapshot) => {
    const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
    const snapshotOwnership = resolveSnapshotOwnership(snapshot);
    set((state) => {
      const nextOwnership = mergeOwnership(
        state.ownershipByConnectionUrl[normalizedConnectionUrl],
        snapshotOwnership,
      );
      const ownershipByConnectionUrl = removeOwnershipConflicts(
        state.ownershipByConnectionUrl,
        normalizedConnectionUrl,
        nextOwnership,
      );
      return {
        projectConnectionById: {
          ...state.projectConnectionById,
          ...Object.fromEntries(
            nextOwnership.projectIds.map((projectId) => [projectId, normalizedConnectionUrl]),
          ),
        },
        threadConnectionById: {
          ...state.threadConnectionById,
          ...Object.fromEntries(
            nextOwnership.threadIds.map((threadId) => [threadId, normalizedConnectionUrl]),
          ),
        },
        ownershipByConnectionUrl: {
          ...ownershipByConnectionUrl,
          [normalizedConnectionUrl]: nextOwnership,
        },
      };
    });
  },
  upsertSnapshotOwnership: (connectionUrl, snapshot) => {
    const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
    const nextOwnership = resolveSnapshotOwnership(snapshot);
    set((state) => {
      const previousOwnership = state.ownershipByConnectionUrl[normalizedConnectionUrl];
      const { nextProjectConnectionById, nextThreadConnectionById } = previousOwnership
        ? removeConnectionMappings(
            state.projectConnectionById,
            state.threadConnectionById,
            previousOwnership,
            normalizedConnectionUrl,
          )
        : {
            nextProjectConnectionById: { ...state.projectConnectionById },
            nextThreadConnectionById: { ...state.threadConnectionById },
          };

      for (const projectId of nextOwnership.projectIds) {
        nextProjectConnectionById[projectId] = normalizedConnectionUrl;
      }
      for (const threadId of nextOwnership.threadIds) {
        nextThreadConnectionById[threadId] = normalizedConnectionUrl;
      }
      const ownershipByConnectionUrl = removeOwnershipConflicts(
        state.ownershipByConnectionUrl,
        normalizedConnectionUrl,
        nextOwnership,
      );

      return {
        projectConnectionById: nextProjectConnectionById,
        threadConnectionById: nextThreadConnectionById,
        ownershipByConnectionUrl: {
          ...ownershipByConnectionUrl,
          [normalizedConnectionUrl]: nextOwnership,
        },
      };
    });
  },
  upsertProjectOwnership: (connectionUrl, projectId) => {
    const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
    set((state) => {
      const existingOwnership = state.ownershipByConnectionUrl[normalizedConnectionUrl] ?? {
        projectIds: [],
        threadIds: [],
      };
      const projectIds = existingOwnership.projectIds.includes(projectId)
        ? existingOwnership.projectIds
        : [...existingOwnership.projectIds, projectId];
      const nextOwnership = {
        ...existingOwnership,
        projectIds,
      };
      const ownershipByConnectionUrl = removeOwnershipConflicts(
        state.ownershipByConnectionUrl,
        normalizedConnectionUrl,
        nextOwnership,
      );
      return {
        projectConnectionById: {
          ...state.projectConnectionById,
          [projectId]: normalizedConnectionUrl,
        },
        ownershipByConnectionUrl: {
          ...ownershipByConnectionUrl,
          [normalizedConnectionUrl]: nextOwnership,
        },
      };
    });
  },
  upsertThreadOwnership: (connectionUrl, threadId) => {
    const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
    set((state) => {
      const existingOwnership = state.ownershipByConnectionUrl[normalizedConnectionUrl] ?? {
        projectIds: [],
        threadIds: [],
      };
      const threadIds = existingOwnership.threadIds.includes(threadId)
        ? existingOwnership.threadIds
        : [...existingOwnership.threadIds, threadId];
      const nextOwnership = {
        ...existingOwnership,
        threadIds,
      };
      const ownershipByConnectionUrl = removeOwnershipConflicts(
        state.ownershipByConnectionUrl,
        normalizedConnectionUrl,
        nextOwnership,
      );
      return {
        threadConnectionById: {
          ...state.threadConnectionById,
          [threadId]: normalizedConnectionUrl,
        },
        ownershipByConnectionUrl: {
          ...ownershipByConnectionUrl,
          [normalizedConnectionUrl]: nextOwnership,
        },
      };
    });
  },
  removeConnection: (connectionUrl) => {
    const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
    set((state) => {
      const ownership = state.ownershipByConnectionUrl[normalizedConnectionUrl];
      if (!ownership) {
        return state;
      }
      const { nextProjectConnectionById, nextThreadConnectionById } = removeConnectionMappings(
        state.projectConnectionById,
        state.threadConnectionById,
        ownership,
        normalizedConnectionUrl,
      );
      const ownershipByConnectionUrl = { ...state.ownershipByConnectionUrl };
      delete ownershipByConnectionUrl[normalizedConnectionUrl];
      return {
        projectConnectionById: nextProjectConnectionById,
        threadConnectionById: nextThreadConnectionById,
        ownershipByConnectionUrl,
      };
    });
  },
}));

export function useProjectConnectionUrl(projectId: ProjectId | null | undefined): string | null {
  const selector = projectId
    ? (state: HostConnectionState) => state.projectConnectionById[projectId] ?? null
    : () => null;
  return useHostConnectionStore(selector);
}

export function useThreadConnectionUrl(threadId: ThreadId | null | undefined): string | null {
  const selector = threadId
    ? (state: HostConnectionState) => state.threadConnectionById[threadId] ?? null
    : () => null;
  return useHostConnectionStore(selector);
}
