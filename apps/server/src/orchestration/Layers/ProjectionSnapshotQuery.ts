import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  type OrchestrationGetSnapshotInput,
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
  type OrchestrationThreadActivity,
  ModelSelection,
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
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
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
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
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

function toOrchestrationCheckpointSummary(
  row: Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>,
): OrchestrationCheckpointSummary {
  return {
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
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
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
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

function resolveSnapshotHydrationMode(input?: OrchestrationGetSnapshotInput): {
  readonly hydrateAllThreadHistory: boolean;
  readonly hydrateThreadId: ThreadId | null;
} {
  if (input === undefined || !Object.prototype.hasOwnProperty.call(input, "hydrateThreadId")) {
    return {
      hydrateAllThreadHistory: true,
      hydrateThreadId: null,
    };
  }

  return {
    hydrateAllThreadHistory: false,
    hydrateThreadId: input.hydrateThreadId ?? null,
  };
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
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
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listSummaryThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          ranked.message_id AS "messageId",
          ranked.thread_id AS "threadId",
          ranked.turn_id AS "turnId",
          ranked.role AS "role",
          ranked.text AS "text",
          ranked.attachments_json AS "attachments",
          ranked.is_streaming AS "isStreaming",
          ranked.sequence AS "sequence",
          ranked.created_at AS "createdAt",
          ranked.updated_at AS "updatedAt"
        FROM (
          SELECT
            message_id,
            thread_id,
            turn_id,
            role,
            text,
            attachments_json,
            is_streaming,
            sequence,
            created_at,
            updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY created_at DESC, message_id DESC
            ) AS row_number
          FROM projection_thread_messages
          WHERE role = 'user'
        ) AS ranked
        WHERE ranked.row_number = 1
        ORDER BY ranked.thread_id ASC
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

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
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
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
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
          ranked.thread_id AS "threadId",
          ranked.plan_id AS "planId",
          ranked.turn_id AS "turnId",
          ranked.implemented_at AS "implementedAt",
          ranked.implementation_thread_id AS "implementationThreadId",
          ranked.created_at AS "createdAt",
          ranked.updated_at AS "updatedAt"
        FROM (
          SELECT
            thread_id,
            plan_id,
            turn_id,
            implemented_at,
            implementation_thread_id,
            created_at,
            updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY updated_at DESC, plan_id DESC
            ) AS row_number
          FROM projection_thread_proposed_plans
        ) AS ranked
        WHERE ranked.row_number = 1
        ORDER BY ranked.thread_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
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
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listSidebarThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
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
        WHERE kind IN (
          'approval.requested',
          'approval.resolved',
          'provider.approval.respond.failed',
          'user-input.requested',
          'user-input.resolved',
          'provider.user-input.respond.failed'
        )
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
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

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
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

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
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
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
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

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const { hydrateAllThreadHistory, hydrateThreadId } = resolveSnapshotHydrationMode(input);
          const [
            projectRows,
            threadRows,
            summaryMessageRows,
            fullMessageRows,
            summaryProposedPlanRows,
            fullProposedPlanRows,
            summaryActivityRows,
            fullActivityRows,
            sessionRows,
            providerRuntimeRows,
            checkpointRows,
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
            (hydrateAllThreadHistory
              ? Effect.succeed(
                  [] as Array<Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>>,
                )
              : listSummaryThreadMessageRows(undefined)
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listSummaryThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listSummaryThreadMessages:decodeRows",
                ),
              ),
            ),
            (hydrateAllThreadHistory
              ? listThreadMessageRows(undefined)
              : hydrateThreadId !== null
                ? listThreadMessageRowsByThread({ threadId: hydrateThreadId })
                : Effect.succeed(
                    [] as Array<Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>>,
                  )
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listHydratedThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listHydratedThreadMessages:decodeRows",
                ),
              ),
            ),
            (hydrateAllThreadHistory
              ? Effect.succeed(
                  [] as Array<
                    Schema.Schema.Type<typeof ProjectionThreadLatestProposedPlanSummaryDbRowSchema>
                  >,
                )
              : listLatestThreadProposedPlanSummaryRows(undefined)
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listSummaryThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listSummaryThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            (hydrateAllThreadHistory
              ? listThreadProposedPlanRows(undefined)
              : hydrateThreadId !== null
                ? listThreadProposedPlanRowsByThread({ threadId: hydrateThreadId })
                : Effect.succeed(
                    [] as Array<Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>>,
                  )
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listHydratedThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listHydratedThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            (hydrateAllThreadHistory
              ? Effect.succeed(
                  [] as Array<Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>>,
                )
              : listSidebarThreadActivityRows(undefined)
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listSidebarThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listSidebarThreadActivities:decodeRows",
                ),
              ),
            ),
            (hydrateAllThreadHistory
              ? listThreadActivityRows(undefined)
              : hydrateThreadId !== null
                ? listThreadActivityRowsByThread({ threadId: hydrateThreadId })
                : Effect.succeed(
                    [] as Array<Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>>,
                  )
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listHydratedThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listHydratedThreadActivities:decodeRows",
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
            (hydrateAllThreadHistory
              ? listCheckpointRows(undefined)
              : hydrateThreadId !== null
                ? listCheckpointRowsByThread({ threadId: hydrateThreadId })
                : Effect.succeed(
                    [] as Array<Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>>,
                  )
            ).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
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

          const summaryMessagesByThread = new Map<string, Array<OrchestrationMessage>>();
          const fullMessagesByThread = new Map<string, Array<OrchestrationMessage>>();
          const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
          const latestProposedPlanSummaryByThread = new Map<
            string,
            OrchestrationThread["latestProposedPlanSummary"]
          >();
          const summaryActivitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
          const fullActivitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
          const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
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

          for (const row of summaryMessageRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadMessages = summaryMessagesByThread.get(row.threadId) ?? [];
            threadMessages.push(toOrchestrationMessage(row));
            summaryMessagesByThread.set(row.threadId, threadMessages);
          }

          for (const row of fullMessageRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadMessages = fullMessagesByThread.get(row.threadId) ?? [];
            threadMessages.push(toOrchestrationMessage(row));
            fullMessagesByThread.set(row.threadId, threadMessages);
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

          for (const row of fullProposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
            threadProposedPlans.push(toOrchestrationProposedPlan(row));
            proposedPlansByThread.set(row.threadId, threadProposedPlans);
          }

          for (const row of summaryActivityRows) {
            updatedAt = maxIso(updatedAt, row.createdAt);
            const threadActivities = summaryActivitiesByThread.get(row.threadId) ?? [];
            threadActivities.push(toOrchestrationThreadActivity(row));
            summaryActivitiesByThread.set(row.threadId, threadActivities);
          }

          for (const row of fullActivityRows) {
            updatedAt = maxIso(updatedAt, row.createdAt);
            const threadActivities = fullActivitiesByThread.get(row.threadId) ?? [];
            threadActivities.push(toOrchestrationThreadActivity(row));
            fullActivitiesByThread.set(row.threadId, threadActivities);
          }

          for (const row of checkpointRows) {
            updatedAt = maxIso(updatedAt, row.completedAt);
            const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
            threadCheckpoints.push(toOrchestrationCheckpointSummary(row));
            checkpointsByThread.set(row.threadId, threadCheckpoints);
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
            const historyLoaded =
              hydrateAllThreadHistory ||
              (hydrateThreadId !== null && row.threadId === hydrateThreadId);
            const proposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
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
              messages: historyLoaded
                ? sortThreadMessages(fullMessagesByThread.get(row.threadId) ?? [])
                : sortThreadMessages(summaryMessagesByThread.get(row.threadId) ?? []),
              proposedPlans: historyLoaded ? proposedPlans : [],
              latestProposedPlanSummary: historyLoaded
                ? findLatestProposedPlanSummary(proposedPlans)
                : (latestProposedPlanSummaryByThread.get(row.threadId) ?? null),
              activities: historyLoaded
                ? (fullActivitiesByThread.get(row.threadId) ?? [])
                : (summaryActivitiesByThread.get(row.threadId) ?? []),
              checkpoints: historyLoaded ? (checkpointsByThread.get(row.threadId) ?? []) : [],
              session: reconciledThreadState.session,
            };
            if (
              row.handoffSourceThreadId !== null &&
              row.handoffFromProvider !== null &&
              row.handoffToProvider !== null &&
              row.handoffMode !== null &&
              row.handoffCreatedAt !== null
            ) {
              return Object.assign({}, threadBase, {
                handoff: {
                  sourceThreadId: row.handoffSourceThreadId,
                  fromProvider: row.handoffFromProvider,
                  toProvider: row.handoffToProvider,
                  mode: row.handoffMode,
                  createdAt: row.handoffCreatedAt,
                },
              });
            }
            return threadBase;
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
            threadRow.value.handoffCreatedAt !== null
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
);
