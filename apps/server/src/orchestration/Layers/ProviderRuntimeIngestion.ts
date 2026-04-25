import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
} from "@ace/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@ace/shared/DrainableWorker";
import { appendCompactedThreadActivity } from "@ace/shared/orchestrationThreadActivities";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { updateProviderRuntimeIngestionCacheStats } from "../../runtimeProfile.ts";
import { resolveProviderIntegrationCapabilities } from "../../provider/providerCapabilities.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = Math.max(
  256,
  Number.parseInt(process.env.ACE_TURN_MESSAGE_IDS_CACHE_CAPACITY ?? "2000", 10) || 2_000,
);
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(
  Math.max(
    5,
    Number.parseInt(process.env.ACE_TURN_MESSAGE_IDS_CACHE_TTL_MINUTES ?? "45", 10) || 45,
  ),
);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = Math.max(
  512,
  Number.parseInt(process.env.ACE_BUFFERED_ASSISTANT_TEXT_CACHE_CAPACITY ?? "4000", 10) || 4_000,
);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(
  Math.max(
    5,
    Number.parseInt(process.env.ACE_BUFFERED_ASSISTANT_TEXT_CACHE_TTL_MINUTES ?? "45", 10) || 45,
  ),
);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = Math.max(
  256,
  Number.parseInt(process.env.ACE_BUFFERED_PROPOSED_PLAN_CACHE_CAPACITY ?? "2000", 10) || 2_000,
);
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(
  Math.max(
    5,
    Number.parseInt(process.env.ACE_BUFFERED_PROPOSED_PLAN_CACHE_TTL_MINUTES ?? "45", 10) || 45,
  ),
);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS = 96;
const MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS_CURSOR = 96;
const MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS = 96;
const MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS_CURSOR = 96;
const PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY = Math.max(
  256,
  Number.parseInt(process.env.ACE_PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY ?? "10000", 10) ||
    10_000,
);
const PROVIDER_RUNTIME_CACHE_PRESSURE_CHECK_INTERVAL_EVENTS = Math.max(
  32,
  Number.parseInt(
    process.env.ACE_PROVIDER_RUNTIME_CACHE_PRESSURE_CHECK_INTERVAL_EVENTS ?? "256",
    10,
  ) || 256,
);
const PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES = Math.max(
  512 * 1024 * 1024,
  Number.parseInt(
    process.env.ACE_PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES ?? String(1_200 * 1024 * 1024),
    10,
  ) || 1_200 * 1024 * 1024,
);
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.ACE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

function streamingAssistantDeltaBatchLimit(provider: ProviderRuntimeEvent["provider"]): number {
  // Cursor ACP emits many token-sized chunks, so a smaller flush threshold keeps the UI live.
  return provider === "cursor"
    ? MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS_CURSOR
    : MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS;
}

function streamingThinkingActivityBatchLimit(provider: ProviderRuntimeEvent["provider"]): number {
  return provider === "cursor"
    ? MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS_CURSOR
    : MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS;
}

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function runtimeProcessPidFromSessionEvent(event: ProviderRuntimeEvent): number | undefined {
  switch (event.type) {
    case "session.started":
    case "session.state.changed":
    case "session.exited":
      return event.payload.processPid;
    default:
      return undefined;
  }
}

function isRuntimeProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return true;
      }
      if (code === "ESRCH") {
        return false;
      }
    }
    return false;
  }
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function hasRenderableReasoningText(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantStreamKey(
  threadId: ThreadId,
  turnId: TurnId | undefined,
  itemId: ProviderRuntimeEvent["itemId"] | undefined,
) {
  return `${threadId}:${turnId ?? "no-turn"}:${itemId ?? "no-item"}`;
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (
    event.type !== "thread.token-usage.updated" ||
    event.payload.usage.usedTokens <= 0 ||
    event.payload.usage.maxTokens === undefined ||
    event.payload.usage.maxTokens <= 0
  ) {
    return undefined;
  }
  return event.payload.usage;
}

function activityFingerprint(activity: OrchestrationThreadActivity): string {
  const payload = (() => {
    try {
      return JSON.stringify(activity.payload);
    } catch {
      return "[unserializable]";
    }
  })();
  return `${activity.kind}|${activity.turnId ?? "none"}|${activity.summary}|${payload}`;
}

type LiveTurnDiffSource = "provider-native" | "provider-reconstructed";

type LiveTurnDiffFile = {
  path: string;
  kind: "modified";
  additions: number;
  deletions: number;
};

type LiveTurnDiffAggregate = {
  source: LiveTurnDiffSource;
  files: Map<string, LiveTurnDiffFile>;
  diff?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function lineCount(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  return value.split("\n").length;
}

function countUnifiedDiffStats(diff: string): { additions: number; deletions: number } {
  return diff.split("\n").reduce(
    (acc, line) => {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) {
        return acc;
      }
      if (line.startsWith("+")) {
        acc.additions += 1;
      } else if (line.startsWith("-")) {
        acc.deletions += 1;
      }
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
}

function summarizeUnifiedDiffFiles(diff: string): ReadonlyArray<LiveTurnDiffFile> {
  const parsed = parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
    path: file.path,
    kind: "modified" as const,
    additions: file.additions,
    deletions: file.deletions,
  }));
  if (parsed.some((file) => file.additions > 0 || file.deletions > 0)) {
    return parsed;
  }

  const fallbackStats = countUnifiedDiffStats(diff);
  if (parsed.length > 0 && (fallbackStats.additions > 0 || fallbackStats.deletions > 0)) {
    return parsed.map((file, index) =>
      index === 0
        ? {
            ...file,
            additions: fallbackStats.additions,
            deletions: fallbackStats.deletions,
          }
        : file,
    );
  }

  return parsed;
}

function extractUnifiedDiffCandidate(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  for (const candidate of [
    asString(record.unifiedDiff),
    asString(record.diff),
    asString(record.patch),
    asString(record.content),
    asString(record.text),
  ]) {
    if (candidate && /(^diff --git |^--- |^@@ )/m.test(candidate)) {
      return candidate;
    }
  }

  for (const key of ["data", "input", "arguments", "result", "rawInput", "rawOutput", "output"]) {
    const nested = extractUnifiedDiffCandidate(record[key]);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function collectPathCandidates(value: unknown, results: Set<string>) {
  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const key of [
    "path",
    "filePath",
    "relativePath",
    "filename",
    "file_name",
    "newPath",
    "oldPath",
  ]) {
    const candidate = asString(record[key])?.trim();
    if (candidate && candidate !== "/dev/null") {
      results.add(candidate);
    }
  }

  for (const key of ["data", "input", "arguments", "result", "rawInput", "rawOutput", "output"]) {
    collectPathCandidates(record[key], results);
  }

  const content = asArray(record.content);
  if (content) {
    for (const entry of content) {
      collectPathCandidates(entry, results);
    }
  }
}

function extractLiveTurnDiffFromItem(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): { files: ReadonlyArray<LiveTurnDiffFile>; diff?: string } | null {
  if (event.payload.itemType !== "file_change") {
    return null;
  }

  const payloadData = asRecord(event.payload.data);
  const unifiedDiff = extractUnifiedDiffCandidate(payloadData);
  if (unifiedDiff) {
    const files = summarizeUnifiedDiffFiles(unifiedDiff);
    if (files.length > 0) {
      return { files, diff: unifiedDiff };
    }
  }

  const content = asArray(payloadData?.content);
  if (content) {
    const diffFiles = content
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter((entry) => entry.type === "diff")
      .map((entry) => {
        const path = asString(entry.path);
        if (!path) {
          return undefined;
        }
        return {
          path,
          kind: "modified" as const,
          additions: lineCount(asString(entry.newText)),
          deletions: lineCount(asString(entry.oldText)),
        };
      })
      .filter((entry): entry is LiveTurnDiffFile => entry !== undefined);
    if (diffFiles.length > 0) {
      return { files: diffFiles };
    }
  }

  const paths = new Set<string>();
  collectPathCandidates(payloadData, paths);
  if (paths.size === 0) {
    const detailPath = event.payload.detail?.trim();
    if (detailPath && !detailPath.includes("\n")) {
      paths.add(detailPath);
    }
  }
  if (paths.size === 0) {
    return null;
  }

  return {
    files: [...paths].map((path) => ({
      path,
      kind: "modified" as const,
      additions: 0,
      deletions: 0,
    })),
  };
}

function asActivityPayloadRecord(
  activity: Pick<OrchestrationThreadActivity, "payload">,
): Record<string, unknown> | null {
  return activity.payload &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function thinkingTaskIdFromActivity(activity: OrchestrationThreadActivity): string | undefined {
  const payload = asActivityPayloadRecord(activity);
  return typeof payload?.taskId === "string" && payload.taskId.length > 0
    ? payload.taskId
    : undefined;
}

function thinkingActivityBufferKey(
  threadId: ThreadId,
  turnId: TurnId | null | undefined,
  taskId: string,
): string {
  return `${threadId}:${turnId ?? "no-turn"}:${taskId}`;
}

function thinkingActivityBufferKeyFromActivity(
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): string | undefined {
  const taskId = thinkingTaskIdFromActivity(activity);
  return taskId ? thinkingActivityBufferKey(threadId, activity.turnId, taskId) : undefined;
}

function isBufferedThinkingActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === "task.progress" && thinkingTaskIdFromActivity(activity) !== undefined;
}

function thinkingActivityDeltaLength(activity: OrchestrationThreadActivity): number {
  const payload = asActivityPayloadRecord(activity);
  const detail =
    typeof payload?.detail === "string"
      ? payload.detail
      : typeof payload?.description === "string"
        ? payload.description
        : typeof payload?.summary === "string"
          ? payload.summary
          : "";
  return detail.length;
}

interface BufferedThinkingActivity {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly taskId: string;
  provider: ProviderRuntimeEvent["provider"];
  activity: OrchestrationThreadActivity;
  pendingCharsSinceFlush: number;
  dirty: boolean;
}

type ActivityStreamingSettings = {
  readonly enableToolStreaming: boolean;
  readonly enableThinkingStreaming: boolean;
};

const ALL_ACTIVITY_STREAMING_SETTINGS: ActivityStreamingSettings = {
  enableToolStreaming: true,
  enableThinkingStreaming: true,
};

function extractReasoningDetail(event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>) {
  if (hasRenderableReasoningText(event.payload.detail)) {
    return event.payload.detail;
  }

  if (event.payload.data && typeof event.payload.data === "object") {
    const payloadData = event.payload.data as Record<string, unknown>;
    if (hasRenderableReasoningText(payloadData.content as string | undefined)) {
      return payloadData.content as string;
    }
  }

  return undefined;
}

function reasoningTaskIdFromEvent(
  event: Pick<ProviderRuntimeEvent, "eventId" | "itemId" | "turnId">,
) {
  return `reasoning:${event.itemId ?? event.turnId ?? event.eventId}`;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return undefined;
  }
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  streamingSettings: ActivityStreamingSettings,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = providerMessageSequence(event);
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      const detail = hasRenderableReasoningText(event.payload.summary)
        ? event.payload.summary
        : hasRenderableReasoningText(event.payload.description)
          ? event.payload.description
          : undefined;
      if (!detail) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail,
            ...(hasRenderableReasoningText(event.payload.summary)
              ? { summary: event.payload.summary }
              : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: truncateDetail(event.payload.summary) } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "content.delta": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      if (
        event.payload.streamKind !== "reasoning_text" &&
        event.payload.streamKind !== "reasoning_summary_text"
      ) {
        return [];
      }

      const detail = hasRenderableReasoningText(event.payload.delta)
        ? event.payload.delta
        : undefined;
      if (!detail) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning",
          payload: {
            taskId: reasoningTaskIdFromEvent(event),
            description: detail,
            detail,
            streamKind: event.payload.streamKind,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      if (event.payload.itemType === "reasoning") {
        if (!streamingSettings.enableThinkingStreaming) {
          return [];
        }
        const detail = extractReasoningDetail(event);
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "info",
            kind: "reasoning.completed",
            summary: event.payload.title ?? "Reasoning",
            payload: {
              taskId: reasoningTaskIdFromEvent(event),
              itemType: event.payload.itemType,
              ...(detail ? { detail } : {}),
              ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: event.payload.title ?? "Tool",
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.title ? { title: event.payload.title } : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

function providerMessageSequence(event: ProviderRuntimeEvent): { sequence?: number | undefined } {
  const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
  return eventWithSequence.sessionSequence !== undefined
    ? { sequence: eventWithSequence.sessionSequence }
    : {};
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function isRenderableAssistantBoundaryActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return false;
  }
  if (activity.kind === "context-window.updated") {
    return false;
  }
  if (activity.summary === "Checkpoint captured") {
    return false;
  }
  return !isPlanBoundaryToolActivity(activity);
}

const make = Effect.fn("make")(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const providerCapabilitiesByProvider = new Map<
    string,
    ReturnType<typeof resolveProviderIntegrationCapabilities>
  >();

  const resolveSessionCapabilities = (provider: ProviderRuntimeEvent["provider"]) => {
    const cached = providerCapabilitiesByProvider.get(provider);
    if (cached) {
      return Effect.succeed(cached);
    }
    return providerService.getCapabilities(provider).pipe(
      Effect.map((capabilities) => resolveProviderIntegrationCapabilities(provider, capabilities)),
      Effect.tap((capabilities) =>
        Effect.sync(() => {
          providerCapabilitiesByProvider.set(provider, capabilities);
        }),
      ),
    );
  };

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });
  const activeAssistantMessageIdByStreamKey = new Map<string, MessageId>();
  const assistantOutputSeenByStreamKey = new Set<string>();
  const pendingStreamingAssistantDeltasByStreamKey = new Map<
    string,
    {
      readonly event: ProviderRuntimeEvent;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly turnId?: TurnId;
      readonly createdAt: string;
      readonly delta: string;
    }
  >();
  const bufferedThinkingActivityByKey = new Map<string, BufferedThinkingActivity>();
  const liveTurnDiffByTurnKey = new Map<string, LiveTurnDiffAggregate>();
  const lastActivityFingerprintByThread = new Map<ThreadId, string>();
  const sessionProcessPidByThread = new Map<ThreadId, number>();
  let runtimeEventsSinceMemoryPressureCheck = 0;

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const publishRuntimeIngestionProfileStats = () => {
    updateProviderRuntimeIngestionCacheStats({
      activeAssistantStreams: activeAssistantMessageIdByStreamKey.size,
      assistantOutputSeenStreams: assistantOutputSeenByStreamKey.size,
      pendingAssistantDeltaStreams: pendingStreamingAssistantDeltasByStreamKey.size,
      bufferedThinkingActivities: bufferedThinkingActivityByKey.size,
      lastActivityFingerprints: lastActivityFingerprintByThread.size,
      trackedSessionPids: sessionProcessPidByThread.size,
      queueCapacity: PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY,
    });
  };
  publishRuntimeIngestionProfileStats();

  const isGitRepoForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const mergeLiveTurnDiffAggregate = (
    current: LiveTurnDiffAggregate | undefined,
    next: {
      readonly source: LiveTurnDiffSource;
      readonly files: ReadonlyArray<LiveTurnDiffFile>;
      readonly diff?: string;
    },
  ): LiveTurnDiffAggregate => {
    const aggregate: LiveTurnDiffAggregate =
      current && current.source === next.source
        ? {
            source: current.source,
            files: new Map(current.files),
            ...(current.diff ? { diff: current.diff } : {}),
          }
        : {
            source: next.source,
            files: new Map<string, LiveTurnDiffFile>(),
          };

    for (const file of next.files) {
      const existing = aggregate.files.get(file.path);
      aggregate.files.set(file.path, {
        path: file.path,
        kind: "modified",
        additions: Math.max(existing?.additions ?? 0, file.additions),
        deletions: Math.max(existing?.deletions ?? 0, file.deletions),
      });
    }

    if (next.diff && next.diff.trim().length > 0) {
      aggregate.diff = next.diff;
    }

    return aggregate;
  };

  const dispatchMissingTurnDiffSummary = Effect.fnUntraced(function* (input: {
    readonly thread: {
      readonly id: ThreadId;
      readonly checkpoints: ReadonlyArray<{
        readonly turnId: TurnId;
        readonly checkpointTurnCount: number;
        readonly status: "ready" | "missing" | "error";
        readonly assistantMessageId: MessageId | null;
      }>;
    };
    readonly event: ProviderRuntimeEvent;
    readonly turnId: TurnId;
    readonly source: LiveTurnDiffSource;
    readonly files: ReadonlyArray<LiveTurnDiffFile>;
    readonly diff: string | undefined;
    readonly now: string;
  }) {
    if (!(yield* isGitRepoForThread(input.thread.id))) {
      return;
    }

    const existingCheckpoint = input.thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === input.turnId,
    );
    if (existingCheckpoint?.status !== undefined && existingCheckpoint.status !== "missing") {
      return;
    }

    const assistantMessageId =
      existingCheckpoint?.assistantMessageId ??
      MessageId.makeUnsafe(
        `assistant:${input.event.itemId ?? input.event.turnId ?? input.event.eventId}`,
      );
    const checkpointTurnCount =
      existingCheckpoint?.checkpointTurnCount ??
      input.thread.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      ) + 1;

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: providerCommandId(input.event, "thread-turn-diff-complete"),
      threadId: input.thread.id,
      turnId: input.turnId,
      completedAt: input.now,
      checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${input.event.eventId}`),
      status: "missing",
      source: input.source,
      files: [...input.files],
      ...(input.diff && input.diff.trim().length > 0 ? { diff: input.diff } : {}),
      assistantMessageId,
      checkpointTurnCount,
      createdAt: input.now,
    });
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap(
        Effect.fn("appendBufferedAssistantText")(function* (existingText) {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const clearTransientRuntimeBuffers = Effect.fn("clearTransientRuntimeBuffers")(function* () {
    yield* flushAllBufferedThinkingActivities().pipe(Effect.ignore);
    yield* flushAllPendingStreamingAssistantDeltas().pipe(Effect.ignore);

    const turnMessageIdsByTurnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const bufferedAssistantTextKeys = Array.from(
      yield* Cache.keys(bufferedAssistantTextByMessageId),
    );
    const bufferedProposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));

    yield* Effect.forEach(
      turnMessageIdsByTurnKeys,
      (key) => Cache.invalidate(turnMessageIdsByTurnKey, key),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      bufferedAssistantTextKeys,
      (messageId) => Cache.invalidate(bufferedAssistantTextByMessageId, messageId),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      bufferedProposedPlanKeys,
      (planId) => Cache.invalidate(bufferedProposedPlanById, planId),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

    const pendingStreamingAssistantDeltas = pendingStreamingAssistantDeltasByStreamKey.size;
    const bufferedThinkingActivities = bufferedThinkingActivityByKey.size;
    const assistantStreams = activeAssistantMessageIdByStreamKey.size;
    const assistantOutputSeen = assistantOutputSeenByStreamKey.size;
    const activityFingerprints = lastActivityFingerprintByThread.size;

    activeAssistantMessageIdByStreamKey.clear();
    assistantOutputSeenByStreamKey.clear();
    pendingStreamingAssistantDeltasByStreamKey.clear();
    bufferedThinkingActivityByKey.clear();
    liveTurnDiffByTurnKey.clear();
    lastActivityFingerprintByThread.clear();
    publishRuntimeIngestionProfileStats();

    return {
      turnMessageIdsByTurnKeys: turnMessageIdsByTurnKeys.length,
      bufferedAssistantTextKeys: bufferedAssistantTextKeys.length,
      bufferedProposedPlanKeys: bufferedProposedPlanKeys.length,
      pendingStreamingAssistantDeltas,
      bufferedThinkingActivities,
      assistantStreams,
      assistantOutputSeen,
      activityFingerprints,
    };
  });

  const maybeTrimTransientRuntimeBuffers = Effect.fn("maybeTrimTransientRuntimeBuffers")(
    function* () {
      runtimeEventsSinceMemoryPressureCheck += 1;
      if (
        runtimeEventsSinceMemoryPressureCheck <
        PROVIDER_RUNTIME_CACHE_PRESSURE_CHECK_INTERVAL_EVENTS
      ) {
        return;
      }
      runtimeEventsSinceMemoryPressureCheck = 0;

      const rssBytes = process.memoryUsage().rss;
      if (rssBytes < PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES) {
        return;
      }

      const cleared = yield* clearTransientRuntimeBuffers();
      yield* Effect.logWarning("provider runtime ingestion trimmed transient buffers", {
        rssBytes,
        thresholdBytes: PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES,
        ...cleared,
      });
    },
  );

  const dispatchThreadActivity = Effect.fn("dispatchThreadActivity")(function* (input: {
    threadId: ThreadId;
    activity: OrchestrationThreadActivity;
    commandId: CommandId;
    createdAt: string;
  }) {
    const fingerprint = activityFingerprint(input.activity);
    if (lastActivityFingerprintByThread.get(input.threadId) === fingerprint) {
      return;
    }
    lastActivityFingerprintByThread.set(input.threadId, fingerprint);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: input.commandId,
      threadId: input.threadId,
      activity: input.activity,
      createdAt: input.createdAt,
    });
  });

  const flushBufferedThinkingActivityByKey = Effect.fn("flushBufferedThinkingActivityByKey")(
    function* (key: string, options?: { readonly discard?: boolean }) {
      const buffered = bufferedThinkingActivityByKey.get(key);
      if (!buffered) {
        return;
      }

      if (buffered.dirty) {
        yield* dispatchThreadActivity({
          threadId: buffered.threadId,
          activity: buffered.activity,
          commandId: CommandId.makeUnsafe(
            `provider:${buffered.activity.id}:thread-activity-buffer-flush:${crypto.randomUUID()}`,
          ),
          createdAt: buffered.activity.createdAt,
        });
        buffered.dirty = false;
        buffered.pendingCharsSinceFlush = 0;
      }

      if (options?.discard) {
        bufferedThinkingActivityByKey.delete(key);
      }
    },
  );

  const flushBufferedThinkingActivitiesForThread = Effect.fn(
    "flushBufferedThinkingActivitiesForThread",
  )(function* (input: { threadId: ThreadId; keepKeys?: ReadonlySet<string> }) {
    for (const [key, buffered] of bufferedThinkingActivityByKey.entries()) {
      if (buffered.threadId !== input.threadId) {
        continue;
      }
      if (input.keepKeys?.has(key)) {
        continue;
      }
      yield* flushBufferedThinkingActivityByKey(key, { discard: true });
    }
  });

  const flushAllBufferedThinkingActivities = Effect.fn("flushAllBufferedThinkingActivities")(
    function* () {
      for (const key of Array.from(bufferedThinkingActivityByKey.keys())) {
        yield* flushBufferedThinkingActivityByKey(key, { discard: true });
      }
    },
  );

  const bufferThinkingActivity = Effect.fn("bufferThinkingActivity")(function* (input: {
    threadId: ThreadId;
    provider: ProviderRuntimeEvent["provider"];
    activity: OrchestrationThreadActivity;
  }) {
    const taskId = thinkingTaskIdFromActivity(input.activity);
    const bufferKey = taskId
      ? thinkingActivityBufferKey(input.threadId, input.activity.turnId, taskId)
      : undefined;
    if (!taskId || !bufferKey) {
      yield* dispatchThreadActivity({
        threadId: input.threadId,
        activity: input.activity,
        commandId: CommandId.makeUnsafe(
          `provider:${input.activity.id}:thread-activity-append:${crypto.randomUUID()}`,
        ),
        createdAt: input.activity.createdAt,
      });
      return;
    }

    const existing = bufferedThinkingActivityByKey.get(bufferKey);
    if (!existing) {
      bufferedThinkingActivityByKey.set(bufferKey, {
        threadId: input.threadId,
        ...(input.activity.turnId ? { turnId: input.activity.turnId } : {}),
        taskId,
        provider: input.provider,
        activity: input.activity,
        pendingCharsSinceFlush: 0,
        dirty: false,
      });
      yield* dispatchThreadActivity({
        threadId: input.threadId,
        activity: input.activity,
        commandId: CommandId.makeUnsafe(
          `provider:${input.activity.id}:thread-activity-append:${crypto.randomUUID()}`,
        ),
        createdAt: input.activity.createdAt,
      });
      return;
    }

    const compactedActivity = appendCompactedThreadActivity([existing.activity], input.activity, {
      maxEntries: 1,
    }).at(0);
    const mergedActivity =
      compactedActivity === undefined
        ? undefined
        : Object.assign({}, compactedActivity, { id: existing.activity.id });
    if (
      !mergedActivity ||
      activityFingerprint(existing.activity) === activityFingerprint(mergedActivity)
    ) {
      return;
    }

    existing.provider = input.provider;
    existing.activity = mergedActivity;
    existing.pendingCharsSinceFlush += thinkingActivityDeltaLength(input.activity);
    existing.dirty = true;

    if (existing.pendingCharsSinceFlush < streamingThinkingActivityBatchLimit(input.provider)) {
      return;
    }

    yield* flushBufferedThinkingActivityByKey(bufferKey);
  });

  const dispatchAssistantDeltaCommand = Effect.fn("dispatchAssistantDeltaCommand")(
    function* (input: {
      event: ProviderRuntimeEvent;
      threadId: ThreadId;
      messageId: MessageId;
      delta: string;
      turnId?: TurnId;
      createdAt: string;
      commandTag: string;
    }) {
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: input.delta,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...providerMessageSequence(input.event),
        createdAt: input.createdAt,
      });
    },
  );

  const flushPendingStreamingAssistantDeltaByStreamKey = Effect.fn(
    "flushPendingStreamingAssistantDeltaByStreamKey",
  )(function* (
    streamKey: string,
    options?: {
      readonly preservePending?: boolean;
    },
  ) {
    const pending = pendingStreamingAssistantDeltasByStreamKey.get(streamKey);
    if (!pending) {
      return;
    }

    if (pending.delta.length === 0) {
      if (!options?.preservePending) {
        pendingStreamingAssistantDeltasByStreamKey.delete(streamKey);
      }
      return;
    }

    yield* dispatchAssistantDeltaCommand({
      event: pending.event,
      threadId: pending.threadId,
      messageId: pending.messageId,
      delta: pending.delta,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      createdAt: pending.createdAt,
      commandTag: "assistant-delta-coalesced",
    });

    if (options?.preservePending) {
      pendingStreamingAssistantDeltasByStreamKey.set(streamKey, {
        ...pending,
        delta: "",
      });
      return;
    }

    pendingStreamingAssistantDeltasByStreamKey.delete(streamKey);
  });

  const flushPendingStreamingAssistantDeltasForTurn = Effect.fn(
    "flushPendingStreamingAssistantDeltasForTurn",
  )(function* (threadId: ThreadId, turnId: TurnId) {
    const prefix = `${threadId}:${turnId}:`;
    for (const streamKey of pendingStreamingAssistantDeltasByStreamKey.keys()) {
      if (!streamKey.startsWith(prefix)) {
        continue;
      }
      yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
    }
  });

  const flushPendingStreamingAssistantDeltasForThread = Effect.fn(
    "flushPendingStreamingAssistantDeltasForThread",
  )(function* (threadId: ThreadId) {
    const prefix = `${threadId}:`;
    for (const streamKey of Array.from(pendingStreamingAssistantDeltasByStreamKey.keys())) {
      if (!streamKey.startsWith(prefix)) {
        continue;
      }
      yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
    }
  });

  const flushAllPendingStreamingAssistantDeltas = Effect.fn(
    "flushAllPendingStreamingAssistantDeltas",
  )(function* () {
    for (const streamKey of Array.from(pendingStreamingAssistantDeltasByStreamKey.keys())) {
      yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
    }
  });

  const clearPendingStreamingAssistantDeltasForThread = (threadId: ThreadId) => {
    const prefix = `${threadId}:`;
    for (const streamKey of pendingStreamingAssistantDeltasByStreamKey.keys()) {
      if (streamKey.startsWith(prefix)) {
        pendingStreamingAssistantDeltasByStreamKey.delete(streamKey);
      }
    }
  };

  const clearAssistantStreamStateForThread = (threadId: ThreadId) => {
    const prefix = `${threadId}:`;
    for (const streamKey of activeAssistantMessageIdByStreamKey.keys()) {
      if (streamKey.startsWith(prefix)) {
        activeAssistantMessageIdByStreamKey.delete(streamKey);
      }
    }
    for (const streamKey of assistantOutputSeenByStreamKey) {
      if (streamKey.startsWith(prefix)) {
        assistantOutputSeenByStreamKey.delete(streamKey);
      }
    }
  };

  const queueStreamingAssistantDelta = Effect.fn("queueStreamingAssistantDelta")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    streamKey: string;
    messageId: MessageId;
    delta: string;
    turnId?: TurnId;
    createdAt: string;
  }) {
    const pending = pendingStreamingAssistantDeltasByStreamKey.get(input.streamKey);
    if (pending && pending.messageId !== input.messageId) {
      yield* flushPendingStreamingAssistantDeltaByStreamKey(input.streamKey);
    }

    const latest = pendingStreamingAssistantDeltasByStreamKey.get(input.streamKey);
    if (!latest) {
      // Emit the first chunk immediately to preserve live streaming UX,
      // then coalesce any subsequent chunks for this stream key.
      yield* dispatchAssistantDeltaCommand({
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
        delta: input.delta,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
        commandTag: "assistant-delta",
      });
      pendingStreamingAssistantDeltasByStreamKey.set(input.streamKey, {
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
        delta: "",
      });
      return;
    }

    pendingStreamingAssistantDeltasByStreamKey.set(input.streamKey, {
      event: input.event,
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: input.createdAt,
      delta: `${latest?.delta ?? ""}${input.delta}`,
    });

    const next = pendingStreamingAssistantDeltasByStreamKey.get(input.streamKey);
    if (!next || next.delta.length < streamingAssistantDeltaBatchLimit(input.event.provider)) {
      return;
    }
    yield* flushPendingStreamingAssistantDeltaByStreamKey(input.streamKey, {
      preservePending: true,
    });
  });

  const activeAssistantStreamKeysForTurn = (threadId: ThreadId, turnId: TurnId) => {
    const prefix = `${threadId}:${turnId}:`;
    return [...activeAssistantMessageIdByStreamKey.keys()].filter((key) => key.startsWith(prefix));
  };

  const clearAssistantOutputSeenForTurn = (threadId: ThreadId, turnId: TurnId) => {
    const prefix = `${threadId}:${turnId}:`;
    for (const streamKey of assistantOutputSeenByStreamKey) {
      if (streamKey.startsWith(prefix)) {
        assistantOutputSeenByStreamKey.delete(streamKey);
      }
    }
  };

  const finalizeAssistantMessage = Effect.fn("finalizeAssistantMessage")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
  }) {
    const bufferedText = yield* takeBufferedAssistantText(input.messageId);
    const text =
      bufferedText.length > 0
        ? bufferedText
        : (input.fallbackText?.trim().length ?? 0) > 0
          ? input.fallbackText!
          : "";

    if (text.length > 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: text,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...providerMessageSequence(input.event),
      createdAt: input.createdAt,
    });
    yield* clearAssistantMessageState(input.messageId);
  });

  const finalizeAssistantMessageSegment = Effect.fn("finalizeAssistantMessageSegment")(
    function* (input: {
      event: ProviderRuntimeEvent;
      threadId: ThreadId;
      turnId?: TurnId;
      streamKey: string;
      messageId: MessageId;
      createdAt: string;
      commandTag: string;
      finalDeltaCommandTag: string;
      fallbackText?: string;
    }) {
      yield* flushPendingStreamingAssistantDeltaByStreamKey(input.streamKey);
      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        ...(input.fallbackText !== undefined ? { fallbackText: input.fallbackText } : {}),
      });
      activeAssistantMessageIdByStreamKey.delete(input.streamKey);
      if (input.turnId) {
        yield* forgetAssistantMessageId(input.threadId, input.turnId, input.messageId);
      }
    },
  );

  const finalizeAssistantMessageSegmentsForTurn = Effect.fn(
    "finalizeAssistantMessageSegmentsForTurn",
  )(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
  }) {
    const streamKeys = activeAssistantStreamKeysForTurn(input.threadId, input.turnId);
    yield* Effect.forEach(
      streamKeys,
      (streamKey) => {
        const messageId = activeAssistantMessageIdByStreamKey.get(streamKey);
        if (!messageId) {
          return Effect.void;
        }
        return finalizeAssistantMessageSegment({
          event: input.event,
          threadId: input.threadId,
          turnId: input.turnId,
          streamKey,
          messageId,
          createdAt: input.createdAt,
          commandTag: input.commandTag,
          finalDeltaCommandTag: input.finalDeltaCommandTag,
        });
      },
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const upsertProposedPlan = Effect.fn("upsertProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) {
    const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
    if (!planMarkdown) {
      return;
    }

    const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: providerCommandId(input.event, "proposed-plan-upsert"),
      threadId: input.threadId,
      proposedPlan: {
        id: input.planId,
        turnId: input.turnId ?? null,
        planMarkdown,
        implementedAt: existingPlan?.implementedAt ?? null,
        implementationThreadId: existingPlan?.implementationThreadId ?? null,
        createdAt: existingPlan?.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
    });
  });

  const finalizeBufferedProposedPlan = Effect.fn("finalizeBufferedProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) {
    const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
    const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
    const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
    const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
    if (!planMarkdown) {
      return;
    }

    yield* upsertProposedPlan({
      event: input.event,
      threadId: input.threadId,
      threadProposedPlans: input.threadProposedPlans,
      planId: input.planId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      planMarkdown,
      createdAt:
        bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
          ? bufferedPlan.createdAt
          : input.updatedAt,
      updatedAt: input.updatedAt,
    });
    yield* clearBufferedProposedPlan(input.planId);
  });

  const clearTurnStateForSession = Effect.fn("clearTurnStateForSession")(function* (
    threadId: ThreadId,
  ) {
    const prefix = `${threadId}:`;
    const proposedPlanPrefix = `plan:${threadId}:`;
    const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
    yield* Effect.forEach(
      turnKeys,
      Effect.fn(function* (key) {
        if (!key.startsWith(prefix)) {
          return;
        }

        const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
        if (Option.isSome(messageIds)) {
          yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
        }

        yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      proposedPlanKeys,
      (key) =>
        key.startsWith(proposedPlanPrefix)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.activeTurnId;
  });

  const getHydratedThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot({
      hydrateThreadId: threadId,
    });
    return snapshot.threads.find((entry) => entry.id === threadId);
  });

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
    eventTurnId: TurnId | undefined,
  ) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fnUntraced(function* (
    sourceThreadId: ThreadId,
    sourcePlanId: OrchestrationProposedPlanId,
    implementationThreadId: ThreadId,
    implementedAt: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    let sourceThread = readModel.threads.find((entry) => entry.id === sourceThreadId);
    let sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
    if (sourceThread && !sourcePlan && sourceThread.proposedPlans.length === 0) {
      sourceThread = yield* getHydratedThread(sourceThreadId);
      sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
    }
    if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.makeUnsafe(
        `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
      ),
      threadId: sourceThread.id,
      proposedPlan: {
        ...sourcePlan,
        implementedAt,
        implementationThreadId,
        updatedAt: implementedAt,
      },
      createdAt: implementedAt,
    });
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    return yield* Effect.gen(function* () {
      yield* maybeTrimTransientRuntimeBuffers();
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === event.threadId);
      if (!thread) return;

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const eventProcessPid = runtimeProcessPidFromSessionEvent(event);
      const trackedSessionProcessPid = sessionProcessPidByThread.get(thread.id);
      const shouldApplySessionExitedLifecycle =
        event.type !== "session.exited" || eventProcessPid === undefined
          ? true
          : (trackedSessionProcessPid === undefined ||
              trackedSessionProcessPid === eventProcessPid) &&
            (event.payload.exitKind === "graceful" || !isRuntimeProcessAlive(eventProcessPid));

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return shouldApplySessionExitedLifecycle;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn) {
              return false;
            }
            // Some providers emit turn completion scoped to the thread but omit
            // turnId. When we already track an active turn for this thread, treat
            // this as completion of that active turn so lifecycle state can close.
            if (missingTurnForActiveTurn) {
              return true;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;
      const serverSettings = yield* serverSettingsService.getSettings;
      const activityVisibilitySettings: ActivityStreamingSettings = {
        enableToolStreaming: serverSettings.enableToolStreaming,
        enableThinkingStreaming: serverSettings.enableThinkingStreaming,
      };
      const activities = runtimeEventToActivities(event, ALL_ACTIVITY_STREAMING_SETTINGS);
      const visibleActivities =
        activityVisibilitySettings.enableToolStreaming &&
        activityVisibilitySettings.enableThinkingStreaming
          ? activities
          : runtimeEventToActivities(event, activityVisibilitySettings);
      const bufferedThinkingKeysForEvent = new Set(
        activities
          .map((activity) => thinkingActivityBufferKeyFromActivity(thread.id, activity))
          .filter((key): key is string => key !== undefined),
      );
      yield* flushBufferedThinkingActivitiesForThread({
        threadId: thread.id,
        ...(bufferedThinkingKeysForEvent.size > 0
          ? { keepKeys: bufferedThinkingKeysForEvent }
          : {}),
      });

      const shouldBreakAssistantMessageSegments = (() => {
        if (
          !eventTurnId ||
          !visibleActivities.some(isRenderableAssistantBoundaryActivity) ||
          (STRICT_PROVIDER_LIFECYCLE_GUARD &&
            activeTurnId !== null &&
            !sameId(activeTurnId, eventTurnId))
        ) {
          return false;
        }
        return true;
      })();

      if (eventTurnId && shouldBreakAssistantMessageSegments) {
        yield* flushPendingStreamingAssistantDeltasForTurn(thread.id, eventTurnId);
        yield* finalizeAssistantMessageSegmentsForTurn({
          event,
          threadId: thread.id,
          turnId: eventTurnId,
          createdAt: now,
          commandTag: "assistant-complete-boundary",
          finalDeltaCommandTag: "assistant-delta-boundary",
        });
      }

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" ||
                event.type === "turn.aborted" ||
                event.type === "session.exited"
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "turn.aborted":
              return "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle) {
          if (
            (event.type === "session.started" || event.type === "session.state.changed") &&
            eventProcessPid !== undefined
          ) {
            sessionProcessPidByThread.set(thread.id, eventProcessPid);
          }
          if (event.type === "session.exited") {
            sessionProcessPidByThread.delete(thread.id);
          }

          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              capabilities: yield* resolveSessionCapabilities(event.provider),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const streamKey = assistantStreamKey(thread.id, turnId, event.itemId);
        const baseAssistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const assistantMessageId =
          activeAssistantMessageIdByStreamKey.get(streamKey) ??
          (assistantOutputSeenByStreamKey.has(streamKey)
            ? MessageId.makeUnsafe(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}:seg:${event.eventId}`,
              )
            : baseAssistantMessageId);
        activeAssistantMessageIdByStreamKey.set(streamKey, assistantMessageId);
        assistantOutputSeenByStreamKey.add(streamKey);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = serverSettings.enableAssistantStreaming
          ? "streaming"
          : "buffered";
        if (assistantDeliveryMode === "buffered") {
          yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* dispatchAssistantDeltaCommand({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
              commandTag: "assistant-delta-buffer-spill",
            });
          }
        } else {
          yield* queueStreamingAssistantDelta({
            event,
            threadId: thread.id,
            streamKey,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.makeUnsafe(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);
        const streamKey = assistantStreamKey(thread.id, turnId, event.itemId);
        yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
        const activeAssistantMessageId = activeAssistantMessageIdByStreamKey.get(streamKey);
        if (activeAssistantMessageId) {
          yield* finalizeAssistantMessageSegment({
            event,
            threadId: thread.id,
            ...(turnId ? { turnId } : {}),
            streamKey,
            messageId: activeAssistantMessageId,
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
          });
        } else if (!assistantOutputSeenByStreamKey.has(streamKey)) {
          const assistantMessageId = assistantCompletion.messageId;
          if (turnId) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
          yield* finalizeAssistantMessageSegment({
            event,
            threadId: thread.id,
            ...(turnId ? { turnId } : {}),
            streamKey,
            messageId: assistantMessageId,
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            ...(assistantCompletion.fallbackText !== undefined
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });
        }
        assistantOutputSeenByStreamKey.delete(streamKey);
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* flushPendingStreamingAssistantDeltasForTurn(thread.id, turnId);
          yield* finalizeAssistantMessageSegmentsForTurn({
            event,
            threadId: thread.id,
            turnId,
            createdAt: now,
            commandTag: "assistant-complete-finalize",
            finalDeltaCommandTag: "assistant-delta-finalize-fallback",
          });
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          clearAssistantOutputSeenForTurn(thread.id, turnId);
          if (event.type === "turn.completed") {
            yield* finalizeBufferedProposedPlan({
              event,
              threadId: thread.id,
              threadProposedPlans: thread.proposedPlans,
              planId: proposedPlanIdForTurn(thread.id, turnId),
              turnId,
              updatedAt: now,
            });
          }
          liveTurnDiffByTurnKey.delete(providerTurnKey(thread.id, turnId));
        }
      }

      if (event.type === "session.exited" && shouldApplySessionExitedLifecycle) {
        yield* flushBufferedThinkingActivitiesForThread({ threadId: thread.id });
        yield* flushPendingStreamingAssistantDeltasForThread(thread.id);
        yield* clearTurnStateForSession(thread.id);
        clearAssistantStreamStateForThread(thread.id);
        clearPendingStreamingAssistantDeltasForThread(thread.id);
        for (const turnKey of liveTurnDiffByTurnKey.keys()) {
          if (turnKey.startsWith(`${thread.id}:`)) {
            liveTurnDiffByTurnKey.delete(turnKey);
          }
        }
        lastActivityFingerprintByThread.delete(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              capabilities: yield* resolveSessionCapabilities(event.provider),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const unifiedDiff = event.payload.unifiedDiff;
          const aggregate = mergeLiveTurnDiffAggregate(
            liveTurnDiffByTurnKey.get(providerTurnKey(thread.id, turnId)),
            {
              source: "provider-native",
              files: summarizeUnifiedDiffFiles(unifiedDiff),
              ...(unifiedDiff.length > 0 ? { diff: unifiedDiff } : {}),
            },
          );
          liveTurnDiffByTurnKey.set(providerTurnKey(thread.id, turnId), aggregate);
          yield* dispatchMissingTurnDiffSummary({
            thread,
            event,
            turnId,
            source: aggregate.source,
            files: [...aggregate.files.values()],
            diff: aggregate.diff,
            now,
          });
        }
      }

      if (
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "file_change"
      ) {
        const turnId = toTurnId(event.turnId);
        const liveTurnDiffMode =
          thread.session?.providerName === event.provider
            ? thread.session.capabilities?.liveTurnDiffMode
            : undefined;
        const extracted =
          liveTurnDiffMode === "workspace" || !turnId ? null : extractLiveTurnDiffFromItem(event);
        if (turnId && extracted && (extracted.files.length > 0 || extracted.diff)) {
          const existingAggregate = liveTurnDiffByTurnKey.get(providerTurnKey(thread.id, turnId));
          if (existingAggregate?.source === "provider-native") {
            // Codex-native turn diffs are authoritative for live turn state.
            // Do not let later file_change lifecycle events degrade them.
            return;
          }
          const aggregate = mergeLiveTurnDiffAggregate(existingAggregate, {
            source: "provider-reconstructed",
            files: extracted.files,
            ...(extracted.diff ? { diff: extracted.diff } : {}),
          });
          liveTurnDiffByTurnKey.set(providerTurnKey(thread.id, turnId), aggregate);
          yield* dispatchMissingTurnDiffSummary({
            thread,
            event,
            turnId,
            source: aggregate.source,
            files: [...aggregate.files.values()],
            diff: aggregate.diff,
            now,
          });
        }
      }

      yield* Effect.forEach(
        activities,
        (activity) =>
          isBufferedThinkingActivity(activity)
            ? bufferThinkingActivity({
                threadId: thread.id,
                provider: event.provider,
                activity,
              })
            : dispatchThreadActivity({
                threadId: thread.id,
                activity,
                commandId: providerCommandId(event, "thread-activity-append"),
                createdAt: activity.createdAt,
              }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    }).pipe(Effect.ensuring(Effect.sync(publishRuntimeIngestionProfileStats)));
  });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely, {
    capacity: PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY,
  });

  const flushBufferedThinkingActivitiesSafely = (phase: "drain" | "shutdown") =>
    flushAllBufferedThinkingActivities().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "provider runtime ingestion failed to flush buffered thinking activities",
          {
            phase,
            cause: Cause.pretty(cause),
          },
        ),
      ),
    );

  const flushBufferedStateOnShutdownSafely = flushAllBufferedThinkingActivities().pipe(
    Effect.flatMap(() => flushAllPendingStreamingAssistantDeltas()),
    Effect.flatMap(() => clearTransientRuntimeBuffers()),
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("provider runtime ingestion failed to flush buffered updates", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.addFinalizer(() => flushBufferedStateOnShutdownSafely);
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(Effect.flatMap(() => flushBufferedThinkingActivitiesSafely("drain"))),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make(),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
