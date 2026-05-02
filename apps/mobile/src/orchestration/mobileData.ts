import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@ace/contracts";
import { connectionManager, type ManagedConnection } from "../rpc/ConnectionManager";
import { resolveProjectAgentStats } from "../projectAgentStats";
import { formatErrorMessage } from "../errors";
import { sortedCopy } from "../sortedCopy";

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

export function resolveMobileThreadStatus(thread: OrchestrationThread): MobileThreadStatus {
  const sessionStatus = thread.session?.status;
  const inputActivity = lastAttentionActivity(thread.activities);

  if (sessionStatus === "error" || thread.latestTurn?.state === "error") {
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
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes <= 0) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function sortByLatest(first: string, second: string): number {
  return second.localeCompare(first);
}

function sortThreads(
  threads: ReadonlyArray<MobileThreadSummary>,
): ReadonlyArray<MobileThreadSummary> {
  return sortedCopy(threads, (left, right) =>
    sortByLatest(left.lastActivityAt, right.lastActivityAt),
  );
}

function sortProjects(
  projects: ReadonlyArray<MobileProjectSummary>,
): ReadonlyArray<MobileProjectSummary> {
  return sortedCopy(projects, (left, right) => {
    const activityComparison = sortByLatest(left.lastActivityAt, right.lastActivityAt);
    if (activityComparison !== 0) {
      return activityComparison;
    }
    return left.project.title.localeCompare(right.project.title);
  });
}

export function useAggregatedOrchestration(): SnapshotState {
  const [connections, setConnections] = useState<ReadonlyArray<ManagedConnection>>(() =>
    connectionManager.getConnections(),
  );
  const [snapshots, setSnapshots] = useState<Record<string, OrchestrationReadModel>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    const nextProjects: MobileProjectSummary[] = [];
    const nextThreads: MobileThreadSummary[] = [];

    for (const connection of connections) {
      const snapshot = snapshots[connection.host.id];
      if (!snapshot) {
        continue;
      }

      const projectsById = new Map(
        snapshot.projects
          .filter((project) => !project.deletedAt)
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
          status: resolveMobileThreadStatus(thread),
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

    const sortedThreads = sortThreads(nextThreads);
    return {
      projects: sortProjects(nextProjects),
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
  }, [connections, snapshots]);

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
