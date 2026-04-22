import { type OrchestrationReadModel, type ProjectId, type ThreadId } from "@ace/contracts";
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
  readonly upsertSnapshotOwnership: (
    connectionUrl: string,
    snapshot: OrchestrationReadModel,
  ) => void;
  readonly upsertProjectOwnership: (connectionUrl: string, projectId: ProjectId) => void;
  readonly upsertThreadOwnership: (connectionUrl: string, threadId: ThreadId) => void;
  readonly removeConnection: (connectionUrl: string) => void;
}

function resolveSnapshotOwnership(snapshot: OrchestrationReadModel): ConnectionOwnership {
  const projectIds = snapshot.projects
    .filter((project) => project.deletedAt === null && project.archivedAt === null)
    .map((project) => project.id);
  const threadIds = snapshot.threads
    .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
    .map((thread) => thread.id);
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

export const useHostConnectionStore = create<HostConnectionState>((set, get) => ({
  projectConnectionById: {},
  threadConnectionById: {},
  ownershipByConnectionUrl: {},
  getOwnership: (connectionUrl) => {
    const normalizedConnectionUrl = normalizeWsUrl(connectionUrl);
    return get().ownershipByConnectionUrl[normalizedConnectionUrl];
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

      return {
        projectConnectionById: nextProjectConnectionById,
        threadConnectionById: nextThreadConnectionById,
        ownershipByConnectionUrl: {
          ...state.ownershipByConnectionUrl,
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
      return {
        projectConnectionById: {
          ...state.projectConnectionById,
          [projectId]: normalizedConnectionUrl,
        },
        ownershipByConnectionUrl: {
          ...state.ownershipByConnectionUrl,
          [normalizedConnectionUrl]: {
            ...existingOwnership,
            projectIds,
          },
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
      return {
        threadConnectionById: {
          ...state.threadConnectionById,
          [threadId]: normalizedConnectionUrl,
        },
        ownershipByConnectionUrl: {
          ...state.ownershipByConnectionUrl,
          [normalizedConnectionUrl]: {
            ...existingOwnership,
            threadIds,
          },
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
