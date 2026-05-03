import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@ace/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@ace/contracts/settings";
import { formatRelativeTimeLabel } from "@ace/shared/timeFormat";
import { connectionManager, type ManagedConnection } from "../rpc/ConnectionManager";
import { resolveProjectAgentStats } from "../projectAgentStats";
import { formatErrorMessage } from "../errors";
import { sortedCopy } from "../sortedCopy";
import { useMobilePreferencesStore } from "../store/MobilePreferencesStore";

export type MobileThreadBucket =
  | "live"
  | "queued"
  | "waiting"
  | "review"
  | "input"
  | "completed"
  | "error"
  | "idle";

export type MobileThreadTone = "accent" | "success" | "warning" | "danger" | "muted";

export interface MobileThreadStatus {
  readonly bucket: MobileThreadBucket;
  readonly label: string;
  readonly tone: MobileThreadTone;
}

export interface MobileProjectSummary {
  readonly hostId: string;
  readonly hostName: string;
  readonly project: OrchestrationProject;
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly liveCount: number;
  readonly completedCount: number;
  readonly pendingCount: number;
  readonly lastActivityAt: string;
}

export interface MobileThreadSummary {
  readonly hostId: string;
  readonly hostName: string;
  readonly project: OrchestrationProject | null;
  readonly thread: OrchestrationThread;
  readonly status: MobileThreadStatus;
  readonly preview: string;
  readonly lastActivityAt: string;
  readonly attentionActivity: OrchestrationThreadActivity | null;
  readonly projectTitle: string;
}

interface SnapshotState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly connections: ReadonlyArray<ManagedConnection>;
  readonly projects: ReadonlyArray<MobileProjectSummary>;
  readonly threads: ReadonlyArray<MobileThreadSummary>;
  readonly activeThreads: ReadonlyArray<MobileThreadSummary>;
  readonly attentionThreads: ReadonlyArray<MobileThreadSummary>;
  readonly connectedHostCount: number;
}

interface MobileAggregationConnection {
  readonly host: {
    readonly id: string;
    readonly name: string;
  };
}

const INPUT_REQUEST_KINDS = new Set(["approval.requested", "user-input.requested"]);

function latestMeaningfulMessage(thread: OrchestrationThread): string {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (!message) {
      continue;
    }
    const text = message.text.trim();
    if (text.length > 0) {
      return text;
    }
  }
  return "New thread";
}

function lastAttentionActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity && INPUT_REQUEST_KINDS.has(activity.kind)) {
      return activity;
    }
  }
  return null;
}

function hasReviewableDiff(thread: OrchestrationThread): boolean {
  return thread.checkpoints.some((checkpoint) => checkpoint.status === "ready");
}

export function resolveMobileThreadErrorDismissalKey(thread: OrchestrationThread): string | null {
  if (thread.session?.status === "error" && thread.session.lastError) {
    return `${thread.session.lastError}\u0000${thread.session.updatedAt}`;
  }
  if (thread.latestTurn?.state === "error") {
    return `${thread.latestTurn.turnId}\u0000${
      thread.latestTurn.completedAt ?? thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt
    }`;
  }
  return null;
}

export function isMobileThreadErrorDismissed(
  thread: OrchestrationThread,
  dismissedThreadErrorKeysById: Readonly<Record<string, string>>,
): boolean {
  const dismissalKey = resolveMobileThreadErrorDismissalKey(thread);
  return dismissalKey !== null && dismissedThreadErrorKeysById[thread.id] === dismissalKey;
}

export function resolveMobileThreadStatus(
  thread: OrchestrationThread,
  dismissedThreadErrorKeysById: Readonly<Record<string, string>> = {},
): MobileThreadStatus {
  const sessionStatus = thread.session?.status;
  const inputActivity = lastAttentionActivity(thread.activities);
  const errorDismissed = isMobileThreadErrorDismissed(thread, dismissedThreadErrorKeysById);

  if (!errorDismissed && (sessionStatus === "error" || thread.latestTurn?.state === "error")) {
    return { bucket: "error", label: "Errored", tone: "danger" };
  }
  if (inputActivity) {
    return { bucket: "input", label: "Input required", tone: "warning" };
  }
  if (hasReviewableDiff(thread)) {
    return { bucket: "review", label: "Diff ready", tone: "accent" };
  }
  if (
    sessionStatus === "starting" ||
    sessionStatus === "running" ||
    thread.latestTurn?.state === "running"
  ) {
    return { bucket: "live", label: "Streaming", tone: "success" };
  }
  if (thread.queuedComposerMessages.length > 0) {
    return { bucket: "queued", label: "Queued", tone: "warning" };
  }
  if (
    thread.latestTurn?.state === "completed" ||
    sessionStatus === "stopped" ||
    sessionStatus === "interrupted"
  ) {
    return { bucket: "completed", label: "Completed", tone: "muted" };
  }
  if (sessionStatus === "ready") {
    return { bucket: "waiting", label: "Ready", tone: "accent" };
  }
  return { bucket: "idle", label: "Idle", tone: "muted" };
}

export function formatTimeAgo(isoDate: string): string {
  return formatRelativeTimeLabel(isoDate);
}

function sortByLatest(first: string, second: string): number {
  return second.localeCompare(first);
}

function toSortableTimestamp(isoDate: string | undefined): number {
  if (!isoDate) {
    return Number.NEGATIVE_INFINITY;
  }
  const timestamp = Date.parse(isoDate);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function getLatestUserMessageTimestamp(thread: OrchestrationThread): number {
  let latestUserMessageTimestamp = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user") {
      continue;
    }
    latestUserMessageTimestamp = Math.max(
      latestUserMessageTimestamp,
      toSortableTimestamp(message.createdAt),
    );
  }
  return latestUserMessageTimestamp === Number.NEGATIVE_INFINITY
    ? toSortableTimestamp(thread.updatedAt || thread.createdAt)
    : latestUserMessageTimestamp;
}

function getThreadSortTimestamp(
  thread: OrchestrationThread,
  sortOrder: SidebarThreadSortOrder,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt);
  }
  if (sortOrder === "updated_at") {
    return toSortableTimestamp(thread.updatedAt || thread.createdAt);
  }
  return getLatestUserMessageTimestamp(thread);
}

function getProjectThreadSortTimestamp(
  thread: OrchestrationThread,
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return toSortableTimestamp(thread.createdAt);
  }
  if (sortOrder === "last_user_message") {
    return getLatestUserMessageTimestamp(thread);
  }
  return toSortableTimestamp(thread.updatedAt || thread.createdAt);
}

export function compareMobileThreads(
  left: OrchestrationThread,
  right: OrchestrationThread,
  sortOrder: SidebarThreadSortOrder,
): number {
  const rightTimestamp = getThreadSortTimestamp(right, sortOrder);
  const leftTimestamp = getThreadSortTimestamp(left, sortOrder);
  const byTimestamp =
    rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  return right.id.localeCompare(left.id);
}

function sortThreads(
  threads: ReadonlyArray<MobileThreadSummary>,
  sortOrder: SidebarThreadSortOrder,
): ReadonlyArray<MobileThreadSummary> {
  return sortedCopy(threads, (left, right) => {
    return compareMobileThreads(left.thread, right.thread, sortOrder);
  });
}

function sortProjects(
  projects: ReadonlyArray<MobileProjectSummary>,
  sortOrder: SidebarProjectSortOrder,
): ReadonlyArray<MobileProjectSummary> {
  if (sortOrder === "manual") {
    return [...projects];
  }
  return sortedCopy(projects, (left, right) => {
    const leftTimestamp =
      left.threads.length > 0
        ? Math.max(
            ...left.threads.map((thread) => getProjectThreadSortTimestamp(thread, sortOrder)),
          )
        : sortOrder === "created_at"
          ? toSortableTimestamp(left.project.createdAt)
          : toSortableTimestamp(left.project.updatedAt || left.project.createdAt);
    const rightTimestamp =
      right.threads.length > 0
        ? Math.max(
            ...right.threads.map((thread) => getProjectThreadSortTimestamp(thread, sortOrder)),
          )
        : sortOrder === "created_at"
          ? toSortableTimestamp(right.project.createdAt)
          : toSortableTimestamp(right.project.updatedAt || right.project.createdAt);
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    return left.project.title.localeCompare(right.project.title);
  });
}

export function aggregateMobileOrchestrationSnapshots({
  connections,
  snapshots,
  sidebarProjectSortOrder,
  sidebarThreadSortOrder,
  dismissedThreadErrorKeysById = {},
}: {
  connections: ReadonlyArray<MobileAggregationConnection>;
  snapshots: Readonly<Record<string, OrchestrationReadModel>>;
  sidebarProjectSortOrder: SidebarProjectSortOrder;
  sidebarThreadSortOrder: SidebarThreadSortOrder;
  dismissedThreadErrorKeysById?: Readonly<Record<string, string>>;
}): {
  readonly activeThreads: ReadonlyArray<MobileThreadSummary>;
  readonly attentionThreads: ReadonlyArray<MobileThreadSummary>;
  readonly projects: ReadonlyArray<MobileProjectSummary>;
  readonly threads: ReadonlyArray<MobileThreadSummary>;
} {
  const nextProjects: MobileProjectSummary[] = [];
  const nextThreads: MobileThreadSummary[] = [];

  for (const connection of connections) {
    const snapshot = snapshots[connection.host.id];
    if (!snapshot) {
      continue;
    }

    const projectsById = new Map(
      snapshot.projects
        .filter((project) => !project.deletedAt && !project.archivedAt)
        .map((project) => [project.id, project] as const),
    );
    const availableThreads = snapshot.threads.filter(
      (thread) => !thread.deletedAt && !thread.archivedAt,
    );

    for (const thread of availableThreads) {
      const project = projectsById.get(thread.projectId) ?? null;
      nextThreads.push({
        hostId: connection.host.id,
        hostName: connection.host.name,
        project,
        thread,
        status: resolveMobileThreadStatus(thread, dismissedThreadErrorKeysById),
        preview: latestMeaningfulMessage(thread),
        lastActivityAt: thread.updatedAt,
        attentionActivity: lastAttentionActivity(thread.activities),
        projectTitle: project?.title ?? "Unknown project",
      });
    }

    for (const project of projectsById.values()) {
      const projectThreads = availableThreads.filter((thread) => thread.projectId === project.id);
      const stats = resolveProjectAgentStats(projectThreads, project.id);
      nextProjects.push({
        hostId: connection.host.id,
        hostName: connection.host.name,
        project,
        threads: projectThreads,
        liveCount: stats.working,
        completedCount: stats.completed,
        pendingCount: stats.pending,
        lastActivityAt:
          sortedCopy(
            projectThreads.map((thread) => thread.updatedAt),
            sortByLatest,
          )[0] ?? project.updatedAt,
      });
    }
  }

  const sortedThreads = sortThreads(nextThreads, sidebarThreadSortOrder);
  return {
    projects: sortProjects(nextProjects, sidebarProjectSortOrder),
    threads: sortedThreads,
    activeThreads: sortedThreads.filter(
      (entry) =>
        entry.status.bucket === "live" ||
        entry.status.bucket === "queued" ||
        entry.status.bucket === "waiting",
    ),
    attentionThreads: sortedThreads.filter(
      (entry) =>
        entry.status.bucket === "review" ||
        entry.status.bucket === "input" ||
        entry.status.bucket === "completed" ||
        entry.status.bucket === "error",
    ),
  };
}

export function useAggregatedOrchestration(): SnapshotState {
  const [connections, setConnections] = useState<ReadonlyArray<ManagedConnection>>(() =>
    connectionManager.getConnections(),
  );
  const [snapshots, setSnapshots] = useState<Record<string, OrchestrationReadModel>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sidebarProjectSortOrder = useMobilePreferencesStore(
    (state) => state.sidebarProjectSortOrder,
  );
  const sidebarThreadSortOrder = useMobilePreferencesStore((state) => state.sidebarThreadSortOrder);
  const dismissedThreadErrorKeysById = useMobilePreferencesStore(
    (state) => state.dismissedThreadErrorKeysById,
  );

  useEffect(() => {
    return connectionManager.onStatusChange((nextConnections) => {
      setConnections(nextConnections);
    });
  }, []);

  const refreshConnectionSnapshots = useCallback(
    async (targetConnections: ReadonlyArray<ManagedConnection>) => {
      if (targetConnections.length === 0) {
        setSnapshots({});
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      const nextSnapshots: Record<string, OrchestrationReadModel> = {};
      const failures: string[] = [];

      await Promise.all(
        targetConnections.map(async (connection) => {
          if (connection.status.kind !== "connected") {
            return;
          }
          try {
            const snapshot = await connection.client.orchestration.getSnapshot();
            nextSnapshots[connection.host.id] = snapshot;
          } catch (cause) {
            failures.push(`${connection.host.name}: ${formatErrorMessage(cause)}`);
          }
        }),
      );

      setSnapshots(nextSnapshots);
      setLoading(false);
      setError(failures.length > 0 ? failures.join("\n") : null);
    },
    [],
  );

  useEffect(() => {
    void refreshConnectionSnapshots(connections);
  }, [connections, refreshConnectionSnapshots]);

  useEffect(() => {
    const unsubscribeFns = connections
      .filter((connection) => connection.status.kind === "connected")
      .map((connection) =>
        connection.client.orchestration.onDomainEvent(() => {
          void connection.client.orchestration
            .getSnapshot()
            .then((snapshot) => {
              setSnapshots((currentSnapshots) => ({
                ...currentSnapshots,
                [connection.host.id]: snapshot,
              }));
            })
            .catch((cause) => {
              setError(`${connection.host.name}: ${formatErrorMessage(cause)}`);
            });
        }),
      );

    return () => {
      unsubscribeFns.forEach((unsubscribe) => unsubscribe());
    };
  }, [connections]);

  const refresh = useCallback(async () => {
    await refreshConnectionSnapshots(connectionManager.getConnections());
  }, [refreshConnectionSnapshots]);

  const { projects, threads, activeThreads, attentionThreads } = useMemo(() => {
    return aggregateMobileOrchestrationSnapshots({
      connections,
      snapshots,
      sidebarProjectSortOrder,
      sidebarThreadSortOrder,
      dismissedThreadErrorKeysById,
    });
  }, [
    connections,
    dismissedThreadErrorKeysById,
    snapshots,
    sidebarProjectSortOrder,
    sidebarThreadSortOrder,
  ]);

  const connectedHostCount = useMemo(
    () => connections.filter((connection) => connection.status.kind === "connected").length,
    [connections],
  );

  return {
    loading,
    error,
    refresh,
    connections,
    projects,
    threads,
    activeThreads,
    attentionThreads,
    connectedHostCount,
  };
}
