import {
  ChatAttachment,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationGetThreadTimelineManifestInput,
  OrchestrationGetThreadTimelineManifestResult,
  OrchestrationGetThreadTimelinePageInput,
  OrchestrationGetThreadTimelinePageResult,
  OrchestrationGetThreadTimelinePagesInput,
  OrchestrationGetThreadTimelinePagesResult,
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
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadTimelineEntryKind,
  type OrchestrationThreadTimelineEntryReference,
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
import { withStartupTiming } from "../../startupDiagnostics.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadTimelineEntryRepository } from "../../persistence/Services/ProjectionThreadTimelineEntries.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadTimelineEntryRepositoryLive } from "../../persistence/Layers/ProjectionThreadTimelineEntries.ts";
import { defaultProviderIntegrationCapabilities } from "../../provider/providerCapabilities.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeThreadTimelineManifest = Schema.decodeUnknownEffect(
  OrchestrationGetThreadTimelineManifestResult,
);
const decodeThreadTimelinePage = Schema.decodeUnknownEffect(
  OrchestrationGetThreadTimelinePageResult,
);
const decodeThreadTimelinePages = Schema.decodeUnknownEffect(
  OrchestrationGetThreadTimelinePagesResult,
);
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    icon: Schema.NullOr(Schema.fromJsonString(ProjectIcon)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    sequence: Schema.NullOr(NonNegativeInt),
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
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
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadTimelinePageRowSchema = Schema.Struct({
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
type ProjectionThreadTimelinePageRow = Schema.Schema.Type<
  typeof ProjectionThreadTimelinePageRowSchema
>;
type MutableTimelineEntryReference = {
  -readonly [Key in keyof OrchestrationThreadTimelineEntryReference]: OrchestrationThreadTimelineEntryReference[Key];
};
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

const DEFAULT_THREAD_TIMELINE_PAGE_SIZE = 128;
const MAX_THREAD_TIMELINE_PAGE_SIZE = 500;
const MAX_THREAD_TIMELINE_BATCH_CONCURRENCY = 4;

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
const ProjectionThreadTimelineManifestRowSchema = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
  totalItems: NonNegativeInt,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
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

function toOrchestrationMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): OrchestrationMessage {
  return {
    id: row.messageId,
    role: row.role,
    text: row.text,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOrchestrationProposedPlan(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOrchestrationThreadActivity(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

function toTimelinePageMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadTimelinePageRowSchema>,
): OrchestrationMessage | null {
  if (row.kind !== "message" || row.messageRole === null || row.messageText === null) {
    return null;
  }
  return {
    id: MessageId.makeUnsafe(row.id),
    role: row.messageRole,
    text: row.messageText,
    ...(row.messageAttachments !== null ? { attachments: row.messageAttachments } : {}),
    turnId: row.turnId,
    streaming: Boolean(row.messageIsStreaming),
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
    updatedAt: row.messageUpdatedAt ?? row.createdAt,
  };
}

function toTimelinePageActivity(
  row: Schema.Schema.Type<typeof ProjectionThreadTimelinePageRowSchema>,
): OrchestrationThreadActivity | null {
  if (row.kind !== "activity") {
    return null;
  }
  const tone =
    row.activityTone === "tool" ||
    row.activityTone === "approval" ||
    row.activityTone === "error" ||
    row.activityTone === "info"
      ? row.activityTone
      : "info";
  const kind =
    row.activityKind && row.activityKind.trim().length > 0 ? row.activityKind : "activity";
  const summary =
    row.activitySummary && row.activitySummary.trim().length > 0 ? row.activitySummary : "Activity";
  return {
    id: EventId.makeUnsafe(row.id),
    tone,
    kind,
    summary,
    payload: row.activityPayload ?? {},
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

function toTimelinePageProposedPlan(
  row: Schema.Schema.Type<typeof ProjectionThreadTimelinePageRowSchema>,
): OrchestrationProposedPlan | null {
  if (row.kind !== "proposed-plan" || row.planMarkdown === null || row.planUpdatedAt === null) {
    return null;
  }
  return {
    id: row.id,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.planImplementedAt,
    implementationThreadId: row.planImplementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.planUpdatedAt,
  };
}

function collectTimelineContent(rows: ReadonlyArray<ProjectionThreadTimelinePageRow>): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
} {
  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const proposedPlans: OrchestrationProposedPlan[] = [];

  for (const row of rows) {
    const message = toTimelinePageMessage(row);
    if (message) {
      messages.push(message);
      continue;
    }
    const activity = toTimelinePageActivity(row);
    if (activity) {
      activities.push(activity);
      continue;
    }
    const proposedPlan = toTimelinePageProposedPlan(row);
    if (proposedPlan) {
      proposedPlans.push(proposedPlan);
    }
  }

  return {
    messages,
    activities,
    proposedPlans,
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

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
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

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getThreadTimelineManifestRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadTimelineManifestRowSchema,
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

  const listThreadTimelinePageRows = SqlSchema.findAll({
    Request: OrchestrationGetThreadTimelinePageInput,
    Result: ProjectionThreadTimelinePageRowSchema,
    execute: (input) => {
      const startIndex = Math.max(0, Math.trunc(input.startIndex));
      const limit = Math.min(MAX_THREAD_TIMELINE_PAGE_SIZE, Math.max(1, Math.trunc(input.limit)));
      if (input.anchor === "tail") {
        return sql`
          WITH thread_meta AS (
            SELECT
              thread.thread_id,
              thread.updated_at AS thread_updated_at,
              (
                SELECT COALESCE(MAX(timeline_index) + 1, 0)
                FROM projection_thread_timeline_entries
                WHERE thread_id = thread.thread_id
              ) AS total_items
            FROM projection_threads AS thread
            WHERE thread.thread_id = ${input.threadId}
              AND thread.deleted_at IS NULL
            LIMIT 1
          ),
          candidate_timeline AS (
            SELECT
              timeline.timeline_index,
              timeline.kind,
              timeline.source_id,
              timeline.turn_id,
              timeline.sequence,
              timeline.created_at,
              thread_meta.total_items,
              thread_meta.thread_updated_at
            FROM projection_thread_timeline_entries AS timeline
            CROSS JOIN thread_meta
            WHERE timeline.thread_id = ${input.threadId}
            ORDER BY timeline.timeline_index DESC
            LIMIT ${limit}
          ),
          selected_timeline AS (
            SELECT
              timeline_index,
              kind,
              source_id,
              turn_id,
              sequence,
              created_at,
              total_items,
              thread_updated_at
            FROM candidate_timeline
            ORDER BY timeline_index ASC
          )
          SELECT
            selected_timeline.kind,
            selected_timeline.source_id AS id,
            selected_timeline.turn_id AS "turnId",
            selected_timeline.sequence,
            selected_timeline.created_at AS "createdAt",
            selected_timeline.timeline_index AS "timelineIndex",
            selected_timeline.total_items AS "totalItems",
            selected_timeline.thread_updated_at AS "threadUpdatedAt",
            message.role AS "messageRole",
            message.text AS "messageText",
            message.attachments_json AS "messageAttachments",
            message.is_streaming AS "messageIsStreaming",
            message.updated_at AS "messageUpdatedAt",
            activity.tone AS "activityTone",
            activity.kind AS "activityKind",
            activity.summary AS "activitySummary",
            activity.payload_json AS "activityPayload",
            proposed_plan.plan_markdown AS "planMarkdown",
            proposed_plan.implemented_at AS "planImplementedAt",
            proposed_plan.implementation_thread_id AS "planImplementationThreadId",
            proposed_plan.updated_at AS "planUpdatedAt"
          FROM selected_timeline
          LEFT JOIN projection_thread_messages AS message
            ON selected_timeline.kind = 'message'
            AND message.thread_id = ${input.threadId}
            AND message.message_id = selected_timeline.source_id
          LEFT JOIN projection_thread_activities AS activity
            ON selected_timeline.kind = 'activity'
            AND activity.thread_id = ${input.threadId}
            AND activity.activity_id = selected_timeline.source_id
          LEFT JOIN projection_thread_proposed_plans AS proposed_plan
            ON selected_timeline.kind = 'proposed-plan'
            AND proposed_plan.thread_id = ${input.threadId}
            AND proposed_plan.plan_id = selected_timeline.source_id
          WHERE (
              message.message_id IS NOT NULL
              OR activity.activity_id IS NOT NULL
              OR proposed_plan.plan_id IS NOT NULL
            )
          ORDER BY selected_timeline.timeline_index ASC
        `;
      }
      return sql`
        WITH thread_meta AS (
          SELECT
            thread.thread_id,
            thread.updated_at AS thread_updated_at,
            (
              SELECT COALESCE(MAX(timeline_index) + 1, 0)
              FROM projection_thread_timeline_entries
              WHERE thread_id = thread.thread_id
            ) AS total_items
          FROM projection_threads AS thread
          WHERE thread.thread_id = ${input.threadId}
            AND thread.deleted_at IS NULL
          LIMIT 1
        ),
        selected_timeline AS (
          SELECT
            timeline.timeline_index,
            timeline.kind,
            timeline.source_id,
            timeline.turn_id,
            timeline.sequence,
            timeline.created_at,
            thread_meta.total_items,
            thread_meta.thread_updated_at
          FROM projection_thread_timeline_entries
            AS timeline
          CROSS JOIN thread_meta
          WHERE timeline.thread_id = ${input.threadId}
            AND timeline.timeline_index >= ${startIndex}
          ORDER BY timeline.timeline_index ASC
          LIMIT ${limit}
        )
        SELECT
          selected_timeline.kind,
          selected_timeline.source_id AS id,
          selected_timeline.turn_id AS "turnId",
          selected_timeline.sequence,
          selected_timeline.created_at AS "createdAt",
          selected_timeline.timeline_index AS "timelineIndex",
          selected_timeline.total_items AS "totalItems",
          selected_timeline.thread_updated_at AS "threadUpdatedAt",
          message.role AS "messageRole",
          message.text AS "messageText",
          message.attachments_json AS "messageAttachments",
          message.is_streaming AS "messageIsStreaming",
          message.updated_at AS "messageUpdatedAt",
          activity.tone AS "activityTone",
          activity.kind AS "activityKind",
          activity.summary AS "activitySummary",
          activity.payload_json AS "activityPayload",
          proposed_plan.plan_markdown AS "planMarkdown",
          proposed_plan.implemented_at AS "planImplementedAt",
          proposed_plan.implementation_thread_id AS "planImplementationThreadId",
          proposed_plan.updated_at AS "planUpdatedAt"
        FROM selected_timeline
        LEFT JOIN projection_thread_messages AS message
          ON selected_timeline.kind = 'message'
          AND message.thread_id = ${input.threadId}
          AND message.message_id = selected_timeline.source_id
        LEFT JOIN projection_thread_activities AS activity
          ON selected_timeline.kind = 'activity'
          AND activity.thread_id = ${input.threadId}
          AND activity.activity_id = selected_timeline.source_id
        LEFT JOIN projection_thread_proposed_plans AS proposed_plan
          ON selected_timeline.kind = 'proposed-plan'
          AND proposed_plan.thread_id = ${input.threadId}
          AND proposed_plan.plan_id = selected_timeline.source_id
        WHERE (
            message.message_id IS NOT NULL
            OR activity.activity_id IS NOT NULL
            OR proposed_plan.plan_id IS NOT NULL
          )
        ORDER BY selected_timeline.timeline_index ASC
      `;
    },
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
        INNER JOIN projection_turns AS turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
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
        INNER JOIN projection_turns AS turns
          ON turns.thread_id = threads.thread_id
         AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.latest_turn_id IS NOT NULL
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

  const getThread: ProjectionSnapshotQueryShape["getThread"] = (threadId) =>
    sql
      .withTransaction(
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

          const [
            messageRows,
            proposedPlanRows,
            activityRows,
            checkpointRows,
            sessionRow,
            providerRuntimeRow,
            latestTurnRow,
          ] = yield* Effect.all([
            listThreadMessageRowsByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThread:listMessages:query",
                  "ProjectionSnapshotQuery.getThread:listMessages:decodeRows",
                ),
              ),
            ),
            listThreadProposedPlanRowsByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThread:listProposedPlans:query",
                  "ProjectionSnapshotQuery.getThread:listProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadActivityRowsByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThread:listActivities:query",
                  "ProjectionSnapshotQuery.getThread:listActivities:decodeRows",
                ),
              ),
            ),
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
          ]);

          const proposedPlans = proposedPlanRows.map(toOrchestrationProposedPlan);
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
            messages: sortThreadMessages(messageRows.map(toOrchestrationMessage)),
            proposedPlans,
            latestProposedPlanSummary: findLatestProposedPlanSummary(proposedPlans),
            queuedComposerMessages: threadRow.value.queuedComposerMessages,
            queuedSteerRequest: threadRow.value.queuedSteerRequest,
            activities: activityRows.map(toOrchestrationThreadActivity),
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
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThread:query")(error);
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

  const readThreadTimelineManifestAfterEntriesCurrent = (
    input: OrchestrationGetThreadTimelineManifestInput,
  ) =>
    Effect.gen(function* () {
      const row = yield* getThreadTimelineManifestRow({ threadId: input.threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadTimelineManifest:query",
            "ProjectionSnapshotQuery.getThreadTimelineManifest:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<OrchestrationGetThreadTimelineManifestResult>();
      }
      const manifest = {
        threadId: input.threadId,
        updatedAt: row.value.updatedAt,
        totalItems: row.value.totalItems,
        tailStartIndex: Math.max(0, row.value.totalItems - DEFAULT_THREAD_TIMELINE_PAGE_SIZE),
      };
      const decodedManifest = yield* decodeThreadTimelineManifest(manifest).pipe(
        Effect.mapError(
          toPersistenceDecodeError(
            "ProjectionSnapshotQuery.getThreadTimelineManifest:decodeManifest",
          ),
        ),
      );
      return Option.some(decodedManifest);
    });

  const getThreadTimelineManifest: ProjectionSnapshotQueryShape["getThreadTimelineManifest"] = (
    input: OrchestrationGetThreadTimelineManifestInput,
  ) =>
    Effect.gen(function* () {
      yield* ensureThreadTimelineEntriesCurrent(input.threadId);
      return yield* readThreadTimelineManifestAfterEntriesCurrent(input);
    });

  const readThreadTimelinePageAfterEntriesCurrent = (
    input: OrchestrationGetThreadTimelinePageInput,
    manifestValue: OrchestrationGetThreadTimelineManifestResult,
  ) =>
    Effect.gen(function* () {
      const limit = Math.min(MAX_THREAD_TIMELINE_PAGE_SIZE, Math.max(1, Math.trunc(input.limit)));
      const isTailPageRequest = input.anchor === "tail";
      const requestedStartIndex = Math.max(0, Math.trunc(input.startIndex));
      const startIndex = isTailPageRequest
        ? 0
        : requestedStartIndex >= manifestValue.totalItems && manifestValue.totalItems > 0
          ? Math.max(0, manifestValue.totalItems - limit)
          : Math.min(requestedStartIndex, manifestValue.totalItems);
      const rows = yield* listThreadTimelinePageRows({
        threadId: input.threadId,
        startIndex,
        limit,
        ...(isTailPageRequest ? { anchor: "tail" as const } : {}),
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadTimelinePage:query",
            "ProjectionSnapshotQuery.getThreadTimelinePage:decodeRows",
          ),
        ),
      );
      if (isTailPageRequest && rows.length === 0) {
        const emptyPage = {
          threadId: input.threadId,
          updatedAt: manifestValue.updatedAt,
          totalItems: manifestValue.totalItems,
          startIndex: 0,
          endIndexExclusive: 0,
          hasPrevious: false,
          hasNext: false,
          entries: [],
          messages: [],
          activities: [],
          proposedPlans: [],
        };
        const decodedEmptyPage = yield* decodeThreadTimelinePage(emptyPage).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadTimelinePage:decodePage"),
          ),
        );
        return decodedEmptyPage;
      }
      const content = collectTimelineContent(rows);
      const entries: OrchestrationThreadTimelineEntryReference[] = rows.map((row) => {
        const entry: MutableTimelineEntryReference = {
          kind: row.kind,
          id: row.id,
          createdAt: row.createdAt,
          index: row.timelineIndex,
        };
        if (row.turnId !== null) {
          entry.turnId = row.turnId;
        }
        if (row.sequence !== null) {
          entry.sequence = row.sequence;
        }
        return entry;
      });
      const firstEntryIndex = entries[0]?.index ?? startIndex;
      const lastEntryIndex = entries.at(-1)?.index ?? firstEntryIndex - 1;
      const totalItems = manifestValue.totalItems;
      const updatedAt = manifestValue.updatedAt;
      const pageStartIndex = Math.max(0, firstEntryIndex);
      const pageEndIndexExclusive =
        entries.length === 0
          ? Math.min(totalItems, startIndex)
          : Math.min(totalItems, lastEntryIndex + 1);
      const page = {
        threadId: input.threadId,
        updatedAt,
        totalItems,
        startIndex: pageStartIndex,
        endIndexExclusive: pageEndIndexExclusive,
        hasPrevious: pageStartIndex > 0,
        hasNext: pageEndIndexExclusive < totalItems,
        entries,
        messages: content.messages,
        activities: content.activities,
        proposedPlans: content.proposedPlans,
      };
      const decodedPage = yield* decodeThreadTimelinePage(page).pipe(
        Effect.mapError(
          toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadTimelinePage:decodePage"),
        ),
      );
      return decodedPage;
    });

  const getThreadTimelinePage: ProjectionSnapshotQueryShape["getThreadTimelinePage"] = (input) =>
    Effect.gen(function* () {
      yield* ensureThreadTimelineEntriesCurrent(input.threadId);
      const manifest = yield* readThreadTimelineManifestAfterEntriesCurrent(input);
      if (Option.isNone(manifest)) {
        return Option.none<OrchestrationGetThreadTimelinePageResult>();
      }
      const page = yield* readThreadTimelinePageAfterEntriesCurrent(input, manifest.value);
      return Option.some(page);
    });

  const getThreadTimelinePages: ProjectionSnapshotQueryShape["getThreadTimelinePages"] = (
    input: OrchestrationGetThreadTimelinePagesInput,
  ) =>
    Effect.gen(function* () {
      yield* ensureThreadTimelineEntriesCurrent(input.threadId);
      const manifest = yield* readThreadTimelineManifestAfterEntriesCurrent(input);
      if (Option.isNone(manifest)) {
        return Option.none<OrchestrationGetThreadTimelinePagesResult>();
      }
      const pages = yield* Effect.all(
        input.pages.map((pageInput) =>
          readThreadTimelinePageAfterEntriesCurrent(
            {
              threadId: input.threadId,
              startIndex: pageInput.startIndex,
              limit: pageInput.limit,
              ...(pageInput.anchor !== undefined ? { anchor: pageInput.anchor } : {}),
            },
            manifest.value,
          ),
        ),
        { concurrency: MAX_THREAD_TIMELINE_BATCH_CONCURRENCY },
      );
      const decodedPages = yield* decodeThreadTimelinePages(pages).pipe(
        Effect.mapError(
          toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadTimelinePages:decodePages"),
        ),
      );
      return Option.some(decodedPages);
    });

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
    getThreadTimelinePage,
    getThreadTimelinePages,
    getThreadTimelineManifest,
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
