import {
  ChatAttachment,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationGetThreadTimelineRowsSnapshotChunkInput,
  OrchestrationGetThreadTimelineRowsSnapshotInput,
  OrchestrationMessageRole,
  OrchestrationCheckpointFile,
  ProviderSessionRuntimeStatus,
  QueuedComposerMessage,
  QueuedSteerRequest,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationGetThreadTimelineRowsSnapshotChunkResult,
  type OrchestrationGetThreadTimelineRowsSnapshotResult,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadTimelineEntryKind,
  type OrchestrationTimelineRow,
  type OrchestrationTimelineRowSourceReference,
  type OrchestrationThreadActivity,
  ModelSelection,
  ProviderIntegrationCapabilities,
  ProviderSessionConfigOption,
  ProviderKind,
  ProviderSlashCommand,
  ProjectIcon,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@ace/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { readPositiveIntegerEnv } from "../../resourceLimits.ts";
import { withStartupTiming } from "../../startupDiagnostics.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadTimelineEntryRepository } from "../../persistence/Services/ProjectionThreadTimelineEntries.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadTimelineEntryRepositoryLive } from "../../persistence/Layers/ProjectionThreadTimelineEntries.ts";
import { defaultProviderIntegrationCapabilities } from "../../provider/providerCapabilities.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

const DEFAULT_TIMELINE_SNAPSHOT_CHUNK_ITEMS = 2_000;
const MAX_TIMELINE_SNAPSHOT_CHUNK_ITEMS = 20_000;
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    icon: Schema.NullOr(Schema.fromJsonString(ProjectIcon)),
  }),
);
const ProjectionThreadLatestProposedPlanSummaryDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  implementedAt: Schema.NullOr(IsoDateTime),
  implementationThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    queuedComposerMessages: Schema.fromJsonString(Schema.Array(QueuedComposerMessage)),
    queuedSteerRequest: Schema.NullOr(Schema.fromJsonString(QueuedSteerRequest)),
  }),
);
const ProjectionThreadTimelineSourceRowSchema = Schema.Struct({
  kind: OrchestrationThreadTimelineEntryKind,
  id: Schema.String,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
  timelineIndex: NonNegativeInt,
  totalItems: NonNegativeInt,
  messageRole: Schema.NullOr(OrchestrationMessageRole),
  messageText: Schema.NullOr(Schema.String),
  messageAttachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  messageIsStreaming: Schema.NullOr(Schema.Number),
  messageUpdatedAt: Schema.NullOr(IsoDateTime),
  threadUpdatedAt: IsoDateTime,
  activityTone: Schema.NullOr(Schema.String),
  activityKind: Schema.NullOr(Schema.String),
  activitySummary: Schema.NullOr(Schema.String),
  activityPayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  planMarkdown: Schema.NullOr(Schema.String),
  planImplementedAt: Schema.NullOr(IsoDateTime),
  planImplementationThreadId: Schema.NullOr(ThreadId),
  planUpdatedAt: Schema.NullOr(IsoDateTime),
});
type ProjectionThreadTimelineSourceRow = Schema.Schema.Type<
  typeof ProjectionThreadTimelineSourceRowSchema
>;
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession.mapFields(
  Struct.assign({
    capabilities: Schema.NullOr(Schema.fromJsonString(ProviderIntegrationCapabilities)),
    configOptions: Schema.fromJsonString(Schema.Array(ProviderSessionConfigOption)),
    commands: Schema.fromJsonString(Schema.Array(ProviderSlashCommand)),
  }),
);
const ProviderSessionRuntimeDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  lastSeenAt: IsoDateTime,
  runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
});
type ProviderSessionRuntimeDbRow = Schema.Schema.Type<typeof ProviderSessionRuntimeDbRowSchema>;

function toLatestProposedPlanSummary(
  proposedPlan: OrchestrationProposedPlan,
): OrchestrationThread["latestProposedPlanSummary"] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

function findLatestProposedPlanSummary(
  proposedPlans: ReadonlyArray<OrchestrationProposedPlan>,
): OrchestrationThread["latestProposedPlanSummary"] {
  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  return latestPlan ? toLatestProposedPlanSummary(latestPlan) : null;
}
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const ProjectionThreadTimelineSnapshotMetadataRowSchema = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
  totalItems: NonNegativeInt,
});
interface ThreadTimelineSnapshotMetadata {
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly totalItems: number;
}
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const ThreadTurnLookupInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});

function toOrchestrationMessageFromTimelineSourceRow(
  row: ProjectionThreadTimelineSourceRow,
): OrchestrationMessage | null {
  if (
    row.kind !== "message" ||
    row.messageRole === null ||
    row.messageText === null ||
    row.messageIsStreaming === null ||
    row.messageUpdatedAt === null
  ) {
    return null;
  }
  return {
    id: MessageId.makeUnsafe(row.id),
    role: row.messageRole,
    text: row.messageText,
    ...(row.messageAttachments !== null ? { attachments: row.messageAttachments } : {}),
    turnId: row.turnId,
    streaming: row.messageIsStreaming === 1,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
    updatedAt: row.messageUpdatedAt,
  };
}

function toOrchestrationProposedPlanFromTimelineSourceRow(
  row: ProjectionThreadTimelineSourceRow,
): OrchestrationProposedPlan | null {
  if (row.kind !== "proposed-plan" || row.planMarkdown === null || row.planUpdatedAt === null) {
    return null;
  }
  return {
    id: OrchestrationProposedPlanId.makeUnsafe(row.id),
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.planImplementedAt,
    implementationThreadId: row.planImplementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.planUpdatedAt,
  };
}

function toOrchestrationActivityFromTimelineSourceRow(
  row: ProjectionThreadTimelineSourceRow,
): OrchestrationThreadActivity | null {
  if (
    row.kind !== "activity" ||
    row.activityTone === null ||
    row.activityKind === null ||
    row.activitySummary === null ||
    row.activityPayload === null
  ) {
    return null;
  }
  return {
    id: EventId.makeUnsafe(row.id),
    tone: row.activityTone as OrchestrationThreadActivity["tone"],
    kind: row.activityKind as OrchestrationThreadActivity["kind"],
    summary: row.activitySummary,
    payload: row.activityPayload,
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

function timelineRowUpdatedAt(row: ProjectionThreadTimelineSourceRow): string {
  if (row.kind === "message") {
    return row.messageUpdatedAt ?? row.createdAt;
  }
  if (row.kind === "proposed-plan") {
    return row.planUpdatedAt ?? row.createdAt;
  }
  return row.threadUpdatedAt > row.createdAt ? row.threadUpdatedAt : row.createdAt;
}

function timelineRowKindForSource(
  row: ProjectionThreadTimelineSourceRow,
): OrchestrationTimelineRow["kind"] {
  if (row.kind === "message") {
    return "message";
  }
  if (row.kind === "proposed-plan") {
    return "proposed-plan";
  }
  return "work";
}

function timelineRowIdForSource(row: ProjectionThreadTimelineSourceRow): string {
  if (row.kind === "proposed-plan") {
    return `proposed-plan:${row.id}`;
  }
  return `${row.kind}:${row.id}`;
}

function timelineRowContentVersion(row: ProjectionThreadTimelineSourceRow): string {
  const updatedAt = timelineRowUpdatedAt(row);
  const textLength =
    row.kind === "message"
      ? (row.messageText?.length ?? 0)
      : row.kind === "activity"
        ? (row.activitySummary?.length ?? 0) +
          (typeof row.activityPayload === "string" ? row.activityPayload.length : 0)
        : (row.planMarkdown?.length ?? 0);
  return `v1:${row.kind}:${row.id}:${updatedAt}:${String(textLength)}`;
}

function toTimelineRowSourceReference(
  row: ProjectionThreadTimelineSourceRow,
): OrchestrationTimelineRowSourceReference {
  return {
    kind: row.kind,
    id: row.id,
    createdAt: row.createdAt,
    sourceIndex: row.timelineIndex,
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
  };
}

function toTimelineRenderRow(row: ProjectionThreadTimelineSourceRow): OrchestrationTimelineRow {
  const updatedAt = timelineRowUpdatedAt(row);
  return {
    id: timelineRowIdForSource(row),
    kind: timelineRowKindForSource(row),
    createdAt: row.createdAt,
    updatedAt,
    contentVersion: timelineRowContentVersion(row),
    startSourceIndex: row.timelineIndex,
    endSourceIndexExclusive: row.timelineIndex + 1,
    ...(row.turnId !== null ? { turnId: row.turnId } : {}),
    sourceRefs: [toTimelineRowSourceReference(row)],
  };
}

function timelinePresentationPriority(input: {
  readonly row: OrchestrationTimelineRow;
  readonly messageById: ReadonlyMap<string, OrchestrationMessage>;
}): number {
  if (input.row.kind !== "message") {
    return 1;
  }
  const sourceRef = input.row.sourceRefs.find((source) => source.kind === "message");
  const message = sourceRef ? input.messageById.get(sourceRef.id) : undefined;
  return message?.role === "assistant" ? 2 : 0;
}

function compareTimelinePresentationRows(
  left: OrchestrationTimelineRow,
  right: OrchestrationTimelineRow,
  messageById: ReadonlyMap<string, OrchestrationMessage>,
): number {
  if (left.turnId && right.turnId && left.turnId === right.turnId) {
    const priority =
      timelinePresentationPriority({ row: left, messageById }) -
      timelinePresentationPriority({ row: right, messageById });
    if (priority !== 0) {
      return priority;
    }
  }
  return (
    left.startSourceIndex - right.startSourceIndex ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function normalizedTimelineRowsRevision(input: {
  readonly threadId: string;
  readonly updatedAt: string;
  readonly totalRows: number;
}): string {
  return `timeline-rows:ui-v3:${input.threadId}:${input.updatedAt}:${String(input.totalRows)}`;
}

function buildTimelineRowsSnapshotFromPresentationRows(input: {
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly messageRows: ReadonlyArray<ProjectionThreadTimelineSourceRow>;
  readonly activityRows: ReadonlyArray<ProjectionThreadTimelineSourceRow>;
  readonly proposedPlanRows: ReadonlyArray<ProjectionThreadTimelineSourceRow>;
}): OrchestrationGetThreadTimelineRowsSnapshotResult {
  const messages: OrchestrationMessage[] = [];
  const proposedPlans: OrchestrationProposedPlan[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const rows: OrchestrationTimelineRow[] = [];
  const messageById = new Map<string, OrchestrationMessage>();

  for (const row of input.messageRows) {
    const message = toOrchestrationMessageFromTimelineSourceRow(row);
    if (!message) {
      continue;
    }
    messages.push(message);
    messageById.set(String(message.id), message);
    rows.push(toTimelineRenderRow(row));
  }

  for (const row of input.activityRows) {
    const activity = toOrchestrationActivityFromTimelineSourceRow(row);
    if (!activity) {
      continue;
    }
    activities.push(activity);
    rows.push(toTimelineRenderRow(row));
  }

  for (const row of input.proposedPlanRows) {
    const proposedPlan = toOrchestrationProposedPlanFromTimelineSourceRow(row);
    if (!proposedPlan) {
      continue;
    }
    proposedPlans.push(proposedPlan);
    rows.push(toTimelineRenderRow(row));
  }

  rows.sort((left, right) => compareTimelinePresentationRows(left, right, messageById));
  const dedupedRows: OrchestrationTimelineRow[] = [];
  const seenRowIds = new Set<string>();
  for (const row of rows) {
    if (seenRowIds.has(row.id)) {
      continue;
    }
    seenRowIds.add(row.id);
    dedupedRows.push(row);
  }
  const totalRows = dedupedRows.length;
  return {
    threadId: input.threadId,
    revision: normalizedTimelineRowsRevision({
      threadId: input.threadId,
      updatedAt: input.updatedAt,
      totalRows,
    }),
    updatedAt: input.updatedAt,
    totalRows,
    rows: dedupedRows,
    messages,
    activities,
    proposedPlans,
  };
}

function sliceTimelineRowsSnapshot(
  snapshot: OrchestrationGetThreadTimelineRowsSnapshotResult,
  input: { readonly startRowIndex: number; readonly limit: number },
): OrchestrationGetThreadTimelineRowsSnapshotResult {
  const start = Math.min(Math.max(0, input.startRowIndex), snapshot.rows.length);
  const end = Math.min(snapshot.rows.length, start + Math.max(1, input.limit));
  const rows = snapshot.rows.slice(start, end);
  const messageIds = new Set<string>();
  const activityIds = new Set<string>();
  const proposedPlanIds = new Set<string>();
  for (const row of rows) {
    for (const sourceRef of row.sourceRefs) {
      if (sourceRef.kind === "message") {
        messageIds.add(sourceRef.id);
      } else if (sourceRef.kind === "activity") {
        activityIds.add(sourceRef.id);
      } else if (sourceRef.kind === "proposed-plan") {
        proposedPlanIds.add(sourceRef.id);
      }
    }
  }
  return {
    ...snapshot,
    rows,
    messages: snapshot.messages.filter((message) => messageIds.has(String(message.id))),
    activities: snapshot.activities.filter((activity) => activityIds.has(String(activity.id))),
    proposedPlans: snapshot.proposedPlans.filter((plan) => proposedPlanIds.has(String(plan.id))),
  };
}

function toOrchestrationCheckpointSummary(
  row: Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>,
): OrchestrationCheckpointSummary {
  return {
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
    source: "git-checkpoint",
    files: row.files,
    assistantMessageId: row.assistantMessageId,
    completedAt: row.completedAt,
  };
}

function toOrchestrationLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function toOrchestrationSession(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  const providerName =
    row.providerName !== null && Schema.is(ProviderKind)(row.providerName)
      ? row.providerName
      : null;

  return {
    threadId: row.threadId,
    status: row.status,
    providerName,
    ...(providerName
      ? {
          capabilities: row.capabilities ?? defaultProviderIntegrationCapabilities(providerName),
        }
      : {}),
    ...(row.configOptions.length > 0 ? { configOptions: row.configOptions } : {}),
    commands: row.commands,
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function readRuntimePayloadLastError(
  runtimePayload: ProviderSessionRuntimeDbRow["runtimePayload"],
) {
  if (
    runtimePayload === null ||
    typeof runtimePayload !== "object" ||
    Array.isArray(runtimePayload)
  ) {
    return null;
  }
  const lastError = "lastError" in runtimePayload ? runtimePayload.lastError : undefined;
  return typeof lastError === "string" && lastError.trim().length > 0 ? lastError : null;
}

function reconcileThreadRuntimeState(input: {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly runtimeRow: ProviderSessionRuntimeDbRow | undefined;
}): {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
} {
  const { session, latestTurn, runtimeRow } = input;
  if (!session || session.status !== "running" || runtimeRow === undefined) {
    return { session, latestTurn };
  }
  if (runtimeRow.status === "running" || runtimeRow.status === "starting") {
    return { session, latestTurn };
  }

  const sessionUpdatedAt = maxIso(session.updatedAt, runtimeRow.lastSeenAt);
  return {
    session: {
      ...session,
      status: runtimeRow.status === "error" ? "error" : "stopped",
      providerName: runtimeRow.providerName,
      runtimeMode: runtimeRow.runtimeMode,
      activeTurnId: null,
      lastError: readRuntimePayloadLastError(runtimeRow.runtimePayload) ?? session.lastError,
      updatedAt: sessionUpdatedAt,
    },
    latestTurn:
      latestTurn && latestTurn.state === "running"
        ? {
            ...latestTurn,
            state: runtimeRow.status === "error" ? "error" : "interrupted",
            completedAt: maxIso(latestTurn.startedAt ?? latestTurn.requestedAt, sessionUpdatedAt),
          }
        : latestTurn,
  };
}

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function compareThreadMessages(
  left: Pick<OrchestrationMessage, "createdAt" | "id" | "sequence">,
  right: Pick<OrchestrationMessage, "createdAt" | "id" | "sequence">,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    compareCompatibleMessageSequence(left.sequence, right.sequence) ||
    left.id.localeCompare(right.id)
  );
}

function compareCompatibleMessageSequence(
  left: number | undefined,
  right: number | undefined,
): number {
  if (
    left === undefined ||
    right === undefined ||
    left === right ||
    isTimestampDerivedSequence(left) !== isTimestampDerivedSequence(right)
  ) {
    return 0;
  }
  return left - right;
}

function isTimestampDerivedSequence(sequence: number): boolean {
  return sequence >= 1_000_000_000_000;
}

function sortThreadMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  return [...messages].toSorted(compareThreadMessages);
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreadTimelineEntryRepository = yield* ProjectionThreadTimelineEntryRepository;

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          icon_json AS "icon",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          handoff_source_thread_id AS "handoffSourceThreadId",
          handoff_from_provider AS "handoffFromProvider",
          handoff_to_provider AS "handoffToProvider",
          handoff_mode AS "handoffMode",
          handoff_created_at AS "handoffCreatedAt",
          fork_source_thread_id AS "forkSourceThreadId",
          fork_created_at AS "forkCreatedAt",
          queued_composer_messages_json AS "queuedComposerMessages",
          queued_steer_request_json AS "queuedSteerRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const getThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          handoff_source_thread_id AS "handoffSourceThreadId",
          handoff_from_provider AS "handoffFromProvider",
          handoff_to_provider AS "handoffToProvider",
          handoff_mode AS "handoffMode",
          handoff_created_at AS "handoffCreatedAt",
          fork_source_thread_id AS "forkSourceThreadId",
          fork_created_at AS "forkCreatedAt",
          queued_composer_messages_json AS "queuedComposerMessages",
          queued_steer_request_json AS "queuedSteerRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listLatestThreadProposedPlanSummaryRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadLatestProposedPlanSummaryDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan.thread_id AS "threadId",
          plan.plan_id AS "planId",
          plan.turn_id AS "turnId",
          plan.implemented_at AS "implementedAt",
          plan.implementation_thread_id AS "implementationThreadId",
          plan.created_at AS "createdAt",
          plan.updated_at AS "updatedAt"
        FROM projection_threads AS thread
        JOIN projection_thread_proposed_plans AS plan
          ON plan.plan_id = (
            SELECT latest.plan_id
            FROM projection_thread_proposed_plans AS latest
            WHERE latest.thread_id = thread.thread_id
            ORDER BY latest.updated_at DESC, latest.plan_id DESC
            LIMIT 1
          )
        WHERE thread.deleted_at IS NULL
        ORDER BY plan.thread_id ASC
      `,
  });

  const listPresentationTimelineMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadTimelineSourceRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH latest_turn AS (
          SELECT turns.turn_id, turns.state
          FROM projection_threads AS thread
          INNER JOIN projection_turns AS turns
            ON turns.thread_id = thread.thread_id
           AND turns.turn_id = thread.latest_turn_id
          WHERE thread.thread_id = ${threadId}
          LIMIT 1
        ),
        terminal_assistant_messages AS (
          SELECT message_id
          FROM (
            SELECT
              message_id,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(turn_id, message_id)
                ORDER BY
                  updated_at DESC,
                  created_at DESC,
                  CASE WHEN sequence IS NULL THEN -1 ELSE sequence END DESC,
                  message_id DESC
              ) AS row_rank
            FROM projection_thread_messages
            WHERE thread_id = ${threadId}
              AND role = 'assistant'
              AND is_streaming = 0
          )
          WHERE row_rank = 1
        )
        SELECT
          timeline.kind AS kind,
          timeline.source_id AS id,
          timeline.turn_id AS "turnId",
          timeline.sequence AS sequence,
          timeline.created_at AS "createdAt",
          timeline.timeline_index AS "timelineIndex",
          0 AS "totalItems",
          message.role AS "messageRole",
          message.text AS "messageText",
          message.attachments_json AS "messageAttachments",
          message.is_streaming AS "messageIsStreaming",
          message.updated_at AS "messageUpdatedAt",
          thread.updated_at AS "threadUpdatedAt",
          NULL AS "activityTone",
          NULL AS "activityKind",
          NULL AS "activitySummary",
          NULL AS "activityPayload",
          NULL AS "planMarkdown",
          NULL AS "planImplementedAt",
          NULL AS "planImplementationThreadId",
          NULL AS "planUpdatedAt"
        FROM projection_thread_timeline_entries AS timeline
        INNER JOIN projection_thread_messages AS message
          ON message.thread_id = timeline.thread_id
         AND message.message_id = timeline.source_id
        INNER JOIN projection_threads AS thread
          ON thread.thread_id = timeline.thread_id
        LEFT JOIN latest_turn AS latest
          ON 1 = 1
        WHERE timeline.thread_id = ${threadId}
          AND timeline.kind = 'message'
          AND (
            message.role IN ('user', 'system')
            OR message.is_streaming = 1
            OR message.turn_id IS NULL
            OR (
              latest.turn_id IS NOT NULL
              AND latest.state = 'running'
              AND message.turn_id = latest.turn_id
            )
            OR message.message_id IN (SELECT message_id FROM terminal_assistant_messages)
          )
        ORDER BY timeline.timeline_index ASC
      `,
  });

  const listPresentationTimelineProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadTimelineSourceRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          timeline.kind AS kind,
          timeline.source_id AS id,
          timeline.turn_id AS "turnId",
          timeline.sequence AS sequence,
          timeline.created_at AS "createdAt",
          timeline.timeline_index AS "timelineIndex",
          0 AS "totalItems",
          NULL AS "messageRole",
          NULL AS "messageText",
          NULL AS "messageAttachments",
          NULL AS "messageIsStreaming",
          NULL AS "messageUpdatedAt",
          thread.updated_at AS "threadUpdatedAt",
          NULL AS "activityTone",
          NULL AS "activityKind",
          NULL AS "activitySummary",
          NULL AS "activityPayload",
          plan.plan_markdown AS "planMarkdown",
          plan.implemented_at AS "planImplementedAt",
          plan.implementation_thread_id AS "planImplementationThreadId",
          plan.updated_at AS "planUpdatedAt"
        FROM projection_thread_timeline_entries AS timeline
        INNER JOIN projection_thread_proposed_plans AS plan
          ON plan.thread_id = timeline.thread_id
         AND plan.plan_id = timeline.source_id
        INNER JOIN projection_threads AS thread
          ON thread.thread_id = timeline.thread_id
        WHERE timeline.thread_id = ${threadId}
          AND timeline.kind = 'proposed-plan'
        ORDER BY timeline.timeline_index ASC
      `,
  });

  const listPresentationTimelineActivityRowsByThreadTurn = SqlSchema.findAll({
    Request: ThreadTurnLookupInput,
    Result: ProjectionThreadTimelineSourceRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          timeline.kind AS kind,
          timeline.source_id AS id,
          timeline.turn_id AS "turnId",
          timeline.sequence AS sequence,
          timeline.created_at AS "createdAt",
          timeline.timeline_index AS "timelineIndex",
          0 AS "totalItems",
          NULL AS "messageRole",
          NULL AS "messageText",
          NULL AS "messageAttachments",
          NULL AS "messageIsStreaming",
          NULL AS "messageUpdatedAt",
          thread.updated_at AS "threadUpdatedAt",
          activity.tone AS "activityTone",
          activity.kind AS "activityKind",
          activity.summary AS "activitySummary",
          activity.payload_json AS "activityPayload",
          NULL AS "planMarkdown",
          NULL AS "planImplementedAt",
          NULL AS "planImplementationThreadId",
          NULL AS "planUpdatedAt"
        FROM projection_thread_timeline_entries AS timeline
        INNER JOIN projection_thread_activities AS activity
          ON activity.thread_id = timeline.thread_id
         AND activity.activity_id = timeline.source_id
        INNER JOIN projection_threads AS thread
          ON thread.thread_id = timeline.thread_id
        WHERE timeline.thread_id = ${threadId}
          AND timeline.kind = 'activity'
          AND timeline.turn_id = ${turnId}
        ORDER BY timeline.timeline_index ASC
      `,
  });

  const listLatestPresentationTimelineActivityRowsByThreadTurn = SqlSchema.findAll({
    Request: ThreadTurnLookupInput,
    Result: ProjectionThreadTimelineSourceRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          timeline.kind AS kind,
          timeline.source_id AS id,
          timeline.turn_id AS "turnId",
          timeline.sequence AS sequence,
          timeline.created_at AS "createdAt",
          timeline.timeline_index AS "timelineIndex",
          0 AS "totalItems",
          NULL AS "messageRole",
          NULL AS "messageText",
          NULL AS "messageAttachments",
          NULL AS "messageIsStreaming",
          NULL AS "messageUpdatedAt",
          thread.updated_at AS "threadUpdatedAt",
          activity.tone AS "activityTone",
          activity.kind AS "activityKind",
          activity.summary AS "activitySummary",
          activity.payload_json AS "activityPayload",
          NULL AS "planMarkdown",
          NULL AS "planImplementedAt",
          NULL AS "planImplementationThreadId",
          NULL AS "planUpdatedAt"
        FROM projection_thread_timeline_entries AS timeline
        INNER JOIN projection_thread_activities AS activity
          ON activity.thread_id = timeline.thread_id
         AND activity.activity_id = timeline.source_id
        INNER JOIN projection_threads AS thread
          ON thread.thread_id = timeline.thread_id
        WHERE timeline.thread_id = ${threadId}
          AND timeline.kind = 'activity'
          AND timeline.turn_id = ${turnId}
          AND activity.kind NOT IN (
            'config.warning',
            'context-compaction',
            'context-window',
            'context-window.updated',
            'checkpoint.captured',
            'deprecation.notice',
            'goal.cleared',
            'goal.updated',
            'runtime.warning'
          )
        ORDER BY timeline.timeline_index DESC
        LIMIT 1
      `,
  });

  const getThreadTimelineSnapshotMetadataRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadTimelineSnapshotMetadataRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread.thread_id AS "threadId",
          thread.updated_at AS "updatedAt",
          (
            SELECT COALESCE(MAX(timeline_index) + 1, 0)
            FROM projection_thread_timeline_entries
            WHERE thread_id = thread.thread_id
          ) AS "totalItems"
        FROM projection_threads AS thread
        WHERE thread.thread_id = ${threadId}
          AND thread.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          capabilities_json AS "capabilities",
          COALESCE(config_options_json, '[]') AS "configOptions",
          COALESCE(commands_json, '[]') AS "commands",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          capabilities_json AS "capabilities",
          COALESCE(config_options_json, '[]') AS "configOptions",
          COALESCE(commands_json, '[]') AS "commands",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const listProviderSessionRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY thread_id ASC
      `,
  });

  const getProviderSessionRuntimeRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        WITH latest_turns AS (
          SELECT
            turns.*,
            ROW_NUMBER() OVER (
              PARTITION BY turns.thread_id
              ORDER BY
                COALESCE(turns.completed_at, turns.started_at, turns.requested_at) DESC,
                turns.turn_id DESC
            ) AS row_number
          FROM projection_turns AS turns
        )
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state AS "state",
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads AS threads
        INNER JOIN latest_turns AS turns
          ON turns.thread_id = threads.thread_id
         AND turns.row_number = 1
        WHERE threads.deleted_at IS NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH latest_turns AS (
          SELECT
            turns.*,
            ROW_NUMBER() OVER (
              PARTITION BY turns.thread_id
              ORDER BY
                COALESCE(turns.completed_at, turns.started_at, turns.requested_at) DESC,
                turns.turn_id DESC
            ) AS row_number
          FROM projection_turns AS turns
          WHERE turns.thread_id = ${threadId}
        )
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state AS "state",
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads AS threads
        INNER JOIN latest_turns AS turns
          ON turns.thread_id = threads.thread_id
         AND turns.row_number = 1
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          icon_json AS "icon",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = (_input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            summaryProposedPlanRows,
            sessionRows,
            providerRuntimeRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
                ),
              ),
            ),
            listLatestThreadProposedPlanSummaryRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listSummaryThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listSummaryThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listProviderSessionRuntimeRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProviderSessionRuntime:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProviderSessionRuntime:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const latestProposedPlanSummaryByThread = new Map<
            string,
            OrchestrationThread["latestProposedPlanSummary"]
          >();
          const sessionsByThread = new Map<string, OrchestrationSession>();
          const providerRuntimeByThread = new Map<string, ProviderSessionRuntimeDbRow>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of providerRuntimeRows) {
            updatedAt = maxIso(updatedAt, row.lastSeenAt);
            providerRuntimeByThread.set(row.threadId, row);
          }

          for (const row of summaryProposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            latestProposedPlanSummaryByThread.set(row.threadId, {
              id: row.planId,
              turnId: row.turnId,
              implementedAt: row.implementedAt,
              implementationThreadId: row.implementationThreadId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            });
          }

          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, toOrchestrationLatestTurn(row));
          }

          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, toOrchestrationSession(row));
          }

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
            id: row.projectId,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            icon: row.icon,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            archivedAt: row.archivedAt,
            deletedAt: row.deletedAt,
          }));

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => {
            const reconciledThreadState = reconcileThreadRuntimeState({
              session: sessionsByThread.get(row.threadId) ?? null,
              latestTurn: latestTurnByThread.get(row.threadId) ?? null,
              runtimeRow: providerRuntimeByThread.get(row.threadId),
            });
            const threadBase: OrchestrationThread = {
              id: row.threadId,
              projectId: row.projectId,
              title: row.title,
              modelSelection: row.modelSelection,
              runtimeMode: row.runtimeMode,
              interactionMode: row.interactionMode,
              branch: row.branch,
              worktreePath: row.worktreePath,
              queuedComposerMessages: row.queuedComposerMessages,
              queuedSteerRequest: row.queuedSteerRequest,
              latestTurn: reconciledThreadState.latestTurn,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              archivedAt: row.archivedAt,
              deletedAt: row.deletedAt,
              messages: [],
              proposedPlans: [],
              latestProposedPlanSummary:
                latestProposedPlanSummaryByThread.get(row.threadId) ?? null,
              activities: [],
              checkpoints: [],
              session: reconciledThreadState.session,
            };
            const threadWithHandoff =
              row.handoffSourceThreadId !== null &&
              row.handoffFromProvider !== null &&
              row.handoffToProvider !== null &&
              row.handoffMode !== null &&
              row.handoffCreatedAt !== null &&
              row.handoffMode !== "fork"
                ? Object.assign({}, threadBase, {
                    handoff: {
                      sourceThreadId: row.handoffSourceThreadId,
                      fromProvider: row.handoffFromProvider,
                      toProvider: row.handoffToProvider,
                      mode: row.handoffMode,
                      createdAt: row.handoffCreatedAt,
                    },
                  })
                : threadBase;
            const forkSourceThreadId =
              row.forkSourceThreadId ??
              (row.handoffMode === "fork" ? row.handoffSourceThreadId : null);
            const forkCreatedAt =
              row.forkCreatedAt ?? (row.handoffMode === "fork" ? row.handoffCreatedAt : null);
            if (forkSourceThreadId !== null && forkCreatedAt !== null) {
              return Object.assign({}, threadWithHandoff, {
                fork: {
                  sourceThreadId: forkSourceThreadId,
                  createdAt: forkCreatedAt,
                },
              });
            }
            return threadWithHandoff;
          });

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };
          return yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const ensureThreadTimelineEntriesCurrent = Effect.fn(
    "ProjectionSnapshotQuery.ensureThreadTimelineEntriesCurrent",
  )(function* (threadId: ThreadId) {
    const completeness = yield* projectionThreadTimelineEntryRepository.getCompletenessByThreadId({
      threadId,
    });
    if (
      completeness.timelineCount === completeness.sourceCount &&
      completeness.timelineSpan === completeness.sourceCount &&
      completeness.indexedSourceCount === completeness.sourceCount
    ) {
      return;
    }
    yield* projectionThreadTimelineEntryRepository.rebuildThread({ threadId });
  });

  const readThreadTimelineSnapshotMetadataAfterEntriesCurrent = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const row = yield* getThreadTimelineSnapshotMetadataRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:metadataQuery",
            "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:metadataDecodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ThreadTimelineSnapshotMetadata>();
      }
      return Option.some({
        threadId,
        updatedAt: row.value.updatedAt,
        totalItems: row.value.totalItems,
      });
    });

  const getThreadTimelineRowsSnapshot: ProjectionSnapshotQueryShape["getThreadTimelineRowsSnapshot"] =
    (input: OrchestrationGetThreadTimelineRowsSnapshotInput) =>
      Effect.gen(function* () {
        yield* ensureThreadTimelineEntriesCurrent(input.threadId);
        const metadata = yield* readThreadTimelineSnapshotMetadataAfterEntriesCurrent(
          input.threadId,
        );
        if (Option.isNone(metadata)) {
          return Option.none<OrchestrationGetThreadTimelineRowsSnapshotResult>();
        }
        const metadataValue = metadata.value;
        const latestTurnRow = yield* getLatestTurnRowByThread({ threadId: input.threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:getLatestTurn:decodeRow",
            ),
          ),
        );
        const activeTurnId =
          Option.isSome(latestTurnRow) && latestTurnRow.value.state === "running"
            ? latestTurnRow.value.turnId
            : null;
        const settledLatestTurnId =
          Option.isSome(latestTurnRow) && latestTurnRow.value.state !== "running"
            ? latestTurnRow.value.turnId
            : null;

        const messageRows = yield* listPresentationTimelineMessageRowsByThread({
          threadId: input.threadId,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:listPresentationMessages:query",
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:listPresentationMessages:decodeRows",
            ),
          ),
        );
        const proposedPlanRows = yield* listPresentationTimelineProposedPlanRowsByThread({
          threadId: input.threadId,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:listPresentationPlans:query",
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:listPresentationPlans:decodeRows",
            ),
          ),
        );
        const activityRows = yield* (
          settledLatestTurnId !== null
            ? listPresentationTimelineActivityRowsByThreadTurn({
                threadId: input.threadId,
                turnId: settledLatestTurnId,
              })
            : activeTurnId !== null
              ? listLatestPresentationTimelineActivityRowsByThreadTurn({
                  threadId: input.threadId,
                  turnId: activeTurnId,
                })
              : Effect.succeed([])
        ).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:listPresentationActivities:query",
              "ProjectionSnapshotQuery.getThreadTimelineRowsSnapshot:listPresentationActivities:decodeRows",
            ),
          ),
        );
        const snapshot = buildTimelineRowsSnapshotFromPresentationRows({
          threadId: input.threadId,
          updatedAt: metadataValue.updatedAt,
          messageRows,
          activityRows,
          proposedPlanRows,
        });
        return Option.some(snapshot);
      });

  const getThreadTimelineRowsSnapshotChunk: ProjectionSnapshotQueryShape["getThreadTimelineRowsSnapshotChunk"] =
    (input: OrchestrationGetThreadTimelineRowsSnapshotChunkInput) =>
      Effect.gen(function* () {
        const snapshot = yield* getThreadTimelineRowsSnapshot({ threadId: input.threadId });
        if (Option.isNone(snapshot)) {
          return Option.none<OrchestrationGetThreadTimelineRowsSnapshotChunkResult>();
        }
        const maxChunkRows = readPositiveIntegerEnv({
          envVarName: "ACE_TIMELINE_SNAPSHOT_CHUNK_ITEMS",
          fallback: DEFAULT_TIMELINE_SNAPSHOT_CHUNK_ITEMS,
          minimum: 100,
          maximum: MAX_TIMELINE_SNAPSHOT_CHUNK_ITEMS,
        });
        const limit = Math.min(input.limit, maxChunkRows);
        const startRowIndex = Math.min(
          Math.max(0, input.startRowIndex),
          snapshot.value.rows.length,
        );
        const sliced = sliceTimelineRowsSnapshot(snapshot.value, { startRowIndex, limit });
        const endRowIndexExclusive = startRowIndex + sliced.rows.length;
        return Option.some({
          ...sliced,
          totalRows: snapshot.value.totalRows,
          startRowIndex,
          endRowIndexExclusive,
          isComplete: endRowIndexExclusive >= snapshot.value.totalRows,
        } satisfies OrchestrationGetThreadTimelineRowsSnapshotChunkResult);
      });

  const getThread: ProjectionSnapshotQueryShape["getThread"] = (threadId) =>
    Effect.gen(function* () {
      const timelineSnapshot = yield* getThreadTimelineRowsSnapshot({ threadId });
      if (Option.isNone(timelineSnapshot)) {
        return Option.none<OrchestrationThread>();
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const threadRow = yield* getThreadRow({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThread:getThread:query",
                "ProjectionSnapshotQuery.getThread:getThread:decodeRow",
              ),
            ),
          );
          if (Option.isNone(threadRow)) {
            return Option.none<OrchestrationThread>();
          }

          const [checkpointRows, sessionRow, providerRuntimeRow, latestTurnRow] = yield* Effect.all(
            [
              listCheckpointRowsByThread({ threadId }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThread:listCheckpoints:query",
                    "ProjectionSnapshotQuery.getThread:listCheckpoints:decodeRows",
                  ),
                ),
              ),
              getThreadSessionRowByThread({ threadId }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThread:getSession:query",
                    "ProjectionSnapshotQuery.getThread:getSession:decodeRow",
                  ),
                ),
              ),
              getProviderSessionRuntimeRowByThread({ threadId }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThread:getProviderSessionRuntime:query",
                    "ProjectionSnapshotQuery.getThread:getProviderSessionRuntime:decodeRow",
                  ),
                ),
              ),
              getLatestTurnRowByThread({ threadId }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getThread:getLatestTurn:query",
                    "ProjectionSnapshotQuery.getThread:getLatestTurn:decodeRow",
                  ),
                ),
              ),
            ],
          );

          const proposedPlans = timelineSnapshot.value.proposedPlans;
          const reconciledThreadState = reconcileThreadRuntimeState({
            session: Option.isSome(sessionRow) ? toOrchestrationSession(sessionRow.value) : null,
            latestTurn: Option.isSome(latestTurnRow)
              ? toOrchestrationLatestTurn(latestTurnRow.value)
              : null,
            runtimeRow: Option.getOrUndefined(providerRuntimeRow),
          });
          const forkSourceThreadId =
            threadRow.value.forkSourceThreadId ??
            (threadRow.value.handoffMode === "fork" ? threadRow.value.handoffSourceThreadId : null);
          const forkCreatedAt =
            threadRow.value.forkCreatedAt ??
            (threadRow.value.handoffMode === "fork" ? threadRow.value.handoffCreatedAt : null);
          const thread = {
            id: threadRow.value.threadId,
            projectId: threadRow.value.projectId,
            title: threadRow.value.title,
            modelSelection: threadRow.value.modelSelection,
            runtimeMode: threadRow.value.runtimeMode,
            interactionMode: threadRow.value.interactionMode,
            branch: threadRow.value.branch,
            worktreePath: threadRow.value.worktreePath,
            ...(threadRow.value.handoffSourceThreadId !== null &&
            threadRow.value.handoffFromProvider !== null &&
            threadRow.value.handoffToProvider !== null &&
            threadRow.value.handoffMode !== null &&
            threadRow.value.handoffCreatedAt !== null &&
            threadRow.value.handoffMode !== "fork"
              ? {
                  handoff: {
                    sourceThreadId: threadRow.value.handoffSourceThreadId,
                    fromProvider: threadRow.value.handoffFromProvider,
                    toProvider: threadRow.value.handoffToProvider,
                    mode: threadRow.value.handoffMode,
                    createdAt: threadRow.value.handoffCreatedAt,
                  },
                }
              : {}),
            ...(forkSourceThreadId !== null && forkCreatedAt !== null
              ? {
                  fork: {
                    sourceThreadId: forkSourceThreadId,
                    createdAt: forkCreatedAt,
                  },
                }
              : {}),
            latestTurn: reconciledThreadState.latestTurn,
            createdAt: threadRow.value.createdAt,
            updatedAt: threadRow.value.updatedAt,
            archivedAt: threadRow.value.archivedAt,
            deletedAt: threadRow.value.deletedAt,
            messages: sortThreadMessages(timelineSnapshot.value.messages),
            proposedPlans,
            latestProposedPlanSummary: findLatestProposedPlanSummary(proposedPlans),
            queuedComposerMessages: threadRow.value.queuedComposerMessages,
            queuedSteerRequest: threadRow.value.queuedSteerRequest,
            activities: timelineSnapshot.value.activities,
            checkpoints: checkpointRows.map(toOrchestrationCheckpointSummary),
            session: reconciledThreadState.session,
          };
          const decodedThread = yield* decodeThread(thread).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getThread:decodeThread"),
            ),
          );
          return Option.some(decodedThread);
        }),
      );
    }).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getThread:query")(error);
      }),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.map(
          Option.map(
            (row): OrchestrationProject => ({
              id: row.projectId,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            }),
          ),
        ),
      );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(toOrchestrationCheckpointSummary),
      });
    });

  return {
    getSnapshot,
    getThread,
    getThreadTimelineRowsSnapshot,
    getThreadTimelineRowsSnapshotChunk,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  withStartupTiming(
    "orchestration",
    "Initializing projection snapshot query",
    makeProjectionSnapshotQuery,
  ),
).pipe(Layer.provideMerge(ProjectionThreadTimelineEntryRepositoryLive));
