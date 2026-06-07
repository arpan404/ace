import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadTimelineEntryKind,
  ThreadId,
  TurnId,
} from "@ace/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadTimelineEntry = Schema.Struct({
  threadId: ThreadId,
  timelineIndex: NonNegativeInt,
  kind: OrchestrationThreadTimelineEntryKind,
  sourceId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadTimelineEntry = typeof ProjectionThreadTimelineEntry.Type;

export const UpsertProjectionThreadTimelineEntryInput = Schema.Struct({
  threadId: ThreadId,
  kind: OrchestrationThreadTimelineEntryKind,
  sourceId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type UpsertProjectionThreadTimelineEntryInput =
  typeof UpsertProjectionThreadTimelineEntryInput.Type;

export const ThreadTimelineThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadTimelineThreadInput = typeof ThreadTimelineThreadInput.Type;

export const DeleteProjectionThreadTimelineSourceInput = Schema.Struct({
  threadId: ThreadId,
  kind: OrchestrationThreadTimelineEntryKind,
  sourceId: Schema.String,
});
export type DeleteProjectionThreadTimelineSourceInput =
  typeof DeleteProjectionThreadTimelineSourceInput.Type;

export const ListProjectionThreadTimelinePageInput = Schema.Struct({
  threadId: ThreadId,
  startIndex: NonNegativeInt,
  limit: NonNegativeInt,
});
export type ListProjectionThreadTimelinePageInput =
  typeof ListProjectionThreadTimelinePageInput.Type;

export interface ProjectionThreadTimelineEntryRepositoryShape {
  readonly upsertSourceEntry: (
    input: UpsertProjectionThreadTimelineEntryInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ThreadTimelineThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteBySource: (
    input: DeleteProjectionThreadTimelineSourceInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly rebuildThread: (
    input: ThreadTimelineThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly countByThreadId: (
    input: ThreadTimelineThreadInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly listPage: (
    input: ListProjectionThreadTimelinePageInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadTimelineEntry>, ProjectionRepositoryError>;
}

export class ProjectionThreadTimelineEntryRepository extends ServiceMap.Service<
  ProjectionThreadTimelineEntryRepository,
  ProjectionThreadTimelineEntryRepositoryShape
>()(
  "ace/persistence/Services/ProjectionThreadTimelineEntries/ProjectionThreadTimelineEntryRepository",
) {}
