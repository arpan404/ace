/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  OrchestrationCheckpointSummary,
  OrchestrationGetThreadTimelineManifestInput,
  OrchestrationGetThreadTimelineManifestResult,
  OrchestrationGetThreadTimelinePageInput,
  OrchestrationGetThreadTimelinePageResult,
  OrchestrationGetSnapshotInput,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@ace/contracts";
import { ServiceMap } from "effect";
import type { Option } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: (
    input?: OrchestrationGetSnapshotInput,
  ) => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read a single fully hydrated active thread.
   */
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a sparse timeline page for a thread without hydrating the full thread history.
   */
  readonly getThreadTimelinePage: (
    input: OrchestrationGetThreadTimelinePageInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationGetThreadTimelinePageResult>,
    ProjectionRepositoryError
  >;

  /**
   * Read the timeline manifest needed to virtualize a thread without fetching rows.
   */
  readonly getThreadTimelineManifest: (
    input: OrchestrationGetThreadTimelineManifestInput,
  ) => Effect.Effect<
    Option.Option<OrchestrationGetThreadTimelineManifestResult>,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends ServiceMap.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("ace/orchestration/Services/ProjectionSnapshotQuery") {}
