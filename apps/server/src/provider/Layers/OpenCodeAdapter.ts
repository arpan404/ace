/**
 * OpenCode adapter — HTTP SDK (`opencode serve`) + SSE event subscription.
 *
 * @module OpenCodeAdapter
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import type {
  Event as OpenCodeSdkEvent,
  Message as OpenCodeSdkMessage,
  OpencodeClient,
  Part as OpenCodeSdkPart,
  PermissionRuleset,
  PermissionRequest as OpenCodeSdkPermissionRequest,
  QuestionRequest as OpenCodeSdkQuestionRequest,
  ReasoningPart as OpenCodeSdkReasoningPart,
  TextPart as OpenCodeSdkTextPart,
  ToolPart as OpenCodeSdkToolPart,
} from "@opencode-ai/sdk/v2/client";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  isFullAccessRuntimeMode,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@ace/contracts";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { meaningfulErrorMessage } from "../errorCause.ts";
import { runLoggedEffect } from "../fireAndForget.ts";
import { buildRuntimeErrorPayload, buildRuntimeWarningPayload } from "../runtimeEventPayloads.ts";
import {
  buildBootstrapPromptFromReplayTurns,
  cloneReplayTurns,
  type TranscriptReplayTurn,
} from "../providerTranscriptBootstrap.ts";
import {
  mergeProviderSlashCommands,
  providerFallbackSlashCommands,
} from "@ace/shared/providerSlashCommands";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { startOpenCodeServerIsolated, type OpenCodeServerHandle } from "../opencodeRuntime.ts";
import {
  type OpenCodeConfigProvidersResponse,
  createOpenCodeSdkClient,
  getOpenCodeModelContextWindowTokens,
  getOpenCodeModelContextWindowTokensFromConfig,
  parseOpenCodeModelSlug,
  resolveOpenCodeModelForPrompt,
} from "../opencodeSdk.ts";
import { asFiniteNumber as asNumber, asObject as asRecord } from "../unknown.ts";
import { type OpenCodeAdapterShape, OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";

const PROVIDER = "opencode" as const;
const ROLLBACK_BOOTSTRAP_MAX_CHARS = 24_000;
const MIN_OPENCODE_IDLE_SESSION_TTL_MS = 15_000;
const MAX_TURN_ITEMS_PER_TURN = 512;

const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);

type OpenCodeSessionContext = {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly cwd: string;
  readonly server: OpenCodeServerHandle;
  readonly client: OpencodeClient;
  readonly opencodeSessionId: string;
  readonly opencodeBaseUrl: string;
  defaultModels: Record<string, string>;
  readonly modelCatalog: OpenCodeConfigProvidersResponse | null;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly replayTurns: Array<TranscriptReplayTurn>;
  totalProcessedTokens: number;
  readonly sequenceTieBreakersByTimestampMs: Map<number, number>;
  nextFallbackSessionSequence: number;
  activeTurn: {
    id: TurnId;
    startedAtMs: number;
    inputText: string;
    attachmentNames: ReadonlyArray<string>;
    assistantText: string;
    assistantItemId: RuntimeItemId;
    assistantStarted: boolean;
    toolItems: Map<string, OpenCodeToolItemState>;
    reasoningItems: Map<string, OpenCodeReasoningItemState>;
    usage?: unknown;
    totalCostUsd?: number;
  } | null;
  pendingApprovals: Map<
    string,
    {
      readonly requestId: RuntimeRequestId;
      readonly requestType: ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"];
      readonly turnId?: TurnId;
    }
  >;
  pendingUserInputs: Map<
    string,
    {
      readonly requestId: RuntimeRequestId;
      readonly turnId?: TurnId;
      readonly questionIds: ReadonlyArray<string>;
    }
  >;
  readonly messageRoleById: Map<string, OpenCodeMessageRole>;
  readonly partById: Map<string, OpenCodeSdkPart>;
  readonly emittedAssistantTextLengthByPartId: Map<string, number>;
  readonly assistantDeltaPartIds: Set<string>;
  readonly reasoningDeltaPartIds: Set<string>;
  sseAbort: AbortController | null;
  idleStopTimer: ReturnType<typeof setTimeout> | null;
  lastActivityAtMs: number;
  pendingBootstrapReset: boolean;
  stopped: boolean;
};

type ProviderRuntimeEventByType<TType extends ProviderRuntimeEvent["type"]> = Extract<
  ProviderRuntimeEvent,
  { type: TType }
>;

type OpenCodeToolItemType = Extract<
  ProviderRuntimeEventByType<"item.started">["payload"]["itemType"],
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "dynamic_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view"
>;

type OpenCodeToolItemState = {
  readonly itemId: RuntimeItemId;
  readonly itemType: OpenCodeToolItemType;
  statusRank: number;
  completed: boolean;
  detail?: string;
};

type OpenCodeReasoningItemState = {
  readonly itemId: RuntimeItemId;
  lastText: string;
  completed: boolean;
};

type OpenCodeMessageRole = Extract<OpenCodeSdkMessage["role"], "assistant" | "user">;

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): { id: TurnId; items: Array<unknown> } {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }
  const created = { id: turnId, items: [] as Array<unknown> };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  const turnSnapshot = resolveTurnSnapshot(context, turnId);
  const itemId = readTurnItemId(item);
  if (itemId === undefined) {
    turnSnapshot.items.push(item);
  } else {
    const existingItemIndex = turnSnapshot.items.findIndex(
      (candidate) => readTurnItemId(candidate) === itemId,
    );
    if (existingItemIndex === -1) {
      turnSnapshot.items.push(item);
    } else {
      turnSnapshot.items[existingItemIndex] = item;
    }
  }

  if (turnSnapshot.items.length > MAX_TURN_ITEMS_PER_TURN) {
    turnSnapshot.items.splice(0, turnSnapshot.items.length - MAX_TURN_ITEMS_PER_TURN);
  }
}

function readTurnItemId(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const { id } = item as { id?: unknown };
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function normalizeOpenCodeAvailableCommands(value: unknown): ReadonlyArray<{
  name: string;
  description?: string;
  inputHint?: string;
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const command = asRecord(entry);
      const name = typeof command?.name === "string" ? command.name.trim() : "";
      if (!name) {
        return null;
      }
      const description =
        typeof command?.description === "string" && command.description.trim().length > 0
          ? command.description.trim()
          : undefined;
      const hints = Array.isArray(command?.hints)
        ? command.hints.filter((hint): hint is string => typeof hint === "string")
        : [];
      const inputHint = hints.length > 0 ? hints.join(" ") : undefined;
      return {
        name,
        ...(description ? { description } : {}),
        ...(inputHint ? { inputHint } : {}),
      };
    })
    .filter((entry): entry is { name: string; description?: string; inputHint?: string } =>
      Boolean(entry),
    );
}

function clearIdleStopTimer(ctx: OpenCodeSessionContext): void {
  if (ctx.idleStopTimer !== null) {
    clearTimeout(ctx.idleStopTimer);
    ctx.idleStopTimer = null;
  }
}

function canAutoStopSession(ctx: OpenCodeSessionContext): boolean {
  return (
    ctx.activeTurn === null && ctx.pendingApprovals.size === 0 && ctx.pendingUserInputs.size === 0
  );
}

async function stopContext(ctx: OpenCodeSessionContext): Promise<void> {
  if (ctx.stopped) {
    return;
  }
  ctx.stopped = true;
  clearIdleStopTimer(ctx);
  ctx.sseAbort?.abort();
  ctx.sseAbort = null;

  let deleteError: ProviderAdapterRequestError | undefined;
  try {
    const deleted = await ctx.client.session.delete({
      sessionID: ctx.opencodeSessionId,
      directory: ctx.cwd,
    });
    if (deleted.error && !isMissingOpenCodeSessionError(deleted.error)) {
      deleteError = new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session.delete",
        detail: toMessage(deleted.error, "Failed to delete OpenCode session"),
      });
    }
  } catch (cause) {
    if (!isMissingOpenCodeSessionError(cause)) {
      deleteError = new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session.delete",
        detail: toMessage(cause, "Failed to delete OpenCode session"),
        cause,
      });
    }
  }

  let closeError: ProviderAdapterRequestError | undefined;
  try {
    await ctx.server.close();
  } catch (cause) {
    closeError = new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session.close",
      detail: toMessage(cause, "Failed to close OpenCode server process"),
      cause,
    });
  }

  if (deleteError && closeError) {
    throw new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session.stop",
      detail: `${deleteError.message} Cleanup also failed: ${closeError.message}`,
      cause: new AggregateError([deleteError, closeError]),
    });
  }
  if (closeError) {
    throw closeError;
  }
  if (deleteError) {
    throw deleteError;
  }
}

type OpenCodeDeltaStreamKind = Extract<
  ProviderRuntimeEventByType<"content.delta">["payload"]["streamKind"],
  "assistant_text" | "reasoning_text" | "reasoning_summary_text"
>;

function asRoundedPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.max(0, Math.round(value));
  return normalized > 0 ? normalized : undefined;
}

function sumPositiveInts(values: ReadonlyArray<number | undefined>): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value ?? 0;
  }
  return total > 0 ? total : undefined;
}

export function buildOpenCodeThreadUsageSnapshot(
  value: unknown,
  toolUses?: number,
  durationMs?: number,
  maxTokens?: number,
): ProviderRuntimeEventByType<"thread.token-usage.updated">["payload"]["usage"] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const inputTokens = asRoundedPositiveInt(record.input);
  const outputTokens = asRoundedPositiveInt(record.output);
  const reasoningOutputTokens = asRoundedPositiveInt(record.reasoning);
  const cache = asRecord(record.cache);
  const cachedInputTokens = sumPositiveInts([
    asRoundedPositiveInt(cache?.read),
    asRoundedPositiveInt(cache?.write),
  ]);
  const usedTokens =
    asRoundedPositiveInt(record.total) ??
    sumPositiveInts([inputTokens, outputTokens, reasoningOutputTokens, cachedInputTokens]);

  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    ...(toolUses !== undefined && toolUses > 0 ? { toolUses: Math.round(toolUses) } : {}),
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs: Math.round(durationMs) } : {}),
    compactsAutomatically: true,
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function currentOpenCodeModelContextWindowTokens(
  context: OpenCodeSessionContext,
): number | undefined {
  let modelSlug = context.session.model;
  if (!modelSlug) {
    return undefined;
  }
  if (modelSlug === "auto" || modelSlug.trim() === "") {
    const defaults = context.defaultModels;
    const providerId = Object.keys(defaults)[0];
    if (providerId) {
      const modelId = defaults[providerId];
      if (modelId) {
        modelSlug = `${providerId}/${modelId}`;
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }
  const tokens =
    context.modelCatalog !== null
      ? getOpenCodeModelContextWindowTokensFromConfig(context.modelCatalog, modelSlug)
      : getOpenCodeModelContextWindowTokens(context.opencodeBaseUrl, modelSlug);
  if (tokens !== undefined) {
    return tokens;
  }
  return undefined;
}

function resolveOpenCodeIdleSessionTtlMs(
  rawValue = process.env.ACE_OPENCODE_IDLE_SESSION_TTL_MS,
): number | null {
  if (rawValue === undefined) {
    return null;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed <= 0) {
    return null;
  }
  return Math.max(MIN_OPENCODE_IDLE_SESSION_TTL_MS, parsed);
}

function parseIsoTimestampMs(value: string): number | undefined {
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  return meaningfulErrorMessage(cause, fallback);
}

export function readOpenCodeResumeSessionId(resumeCursor: unknown): string | undefined {
  const directCursor = nonEmptyString(resumeCursor);
  if (directCursor) {
    return directCursor;
  }
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const cursor = resumeCursor as Record<string, unknown>;
  return (
    nonEmptyString(cursor.sessionId) ??
    nonEmptyString(cursor.sessionID) ??
    nonEmptyString(cursor.id)
  );
}

export function isMissingOpenCodeSessionError(cause: unknown): boolean {
  if (cause === null || cause === undefined) {
    return false;
  }

  if (typeof cause === "string") {
    return cause.toLowerCase().includes("not found");
  }

  if (typeof cause !== "object" || Array.isArray(cause)) {
    return false;
  }

  const record = cause as Record<string, unknown>;
  if (nonEmptyString(record.name)?.toLowerCase() === "notfounderror") {
    return true;
  }
  if (asNumber(record.status) === 404 || asNumber(record.code) === 404) {
    return true;
  }

  const data = asRecord(record.data);
  const message = nonEmptyString(record.message) ?? nonEmptyString(data?.message);
  return message?.toLowerCase().includes("not found") === true;
}

export function openCodeTimestampToIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) < 1_000_000_000) {
      return undefined;
    }
    const timestampMs = Math.abs(value) >= 1_000_000_000_000 ? value : value * 1_000;
    const parsed = new Date(timestampMs);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return openCodeTimestampToIso(Number(trimmed));
  }

  const parsedMs = Date.parse(trimmed);
  return Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : undefined;
}

export function openCodeTimestampToEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Math.abs(value) < 1_000_000_000) {
      return undefined;
    }
    return Math.abs(value) >= 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return openCodeTimestampToEpochMs(Number(trimmed));
  }
  const parsedMs = Date.parse(trimmed);
  return Number.isFinite(parsedMs) ? parsedMs : undefined;
}

function isWithinActiveTurnWindow(
  ctx: OpenCodeSessionContext,
  timestampMs: number | undefined,
): boolean {
  const turn = ctx.activeTurn;
  if (!turn) {
    return false;
  }
  if (timestampMs === undefined) {
    return true;
  }
  // Event streams can drift slightly; tolerate a small negative skew.
  return timestampMs >= turn.startedAtMs - 2_000;
}

export function resolveOpenCodePartTimestamp(
  part: Record<string, unknown>,
  boundary: "start" | "end",
): string | undefined {
  const time = asRecord(part.time);
  if (!time) {
    return undefined;
  }
  return openCodeTimestampToIso(time[boundary]);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const OPENCODE_RETRY_ERROR_MESSAGE_FRAGMENTS = [
  "rate limit",
  "free usage exceeded",
  "usage exceeded",
  "quota exceeded",
  "too many requests",
] as const;

export function isOpenCodeRetryStatusError(status: unknown): boolean {
  const record = asRecord(status);
  if (!record || record.type !== "retry") {
    return false;
  }

  if (asNumber(record.code) === 429 || asNumber(record.status) === 429) {
    return true;
  }

  const nestedError = asRecord(record.error);
  if (asNumber(nestedError?.code) === 429 || asNumber(nestedError?.status) === 429) {
    return true;
  }

  const messageCandidates = [
    nonEmptyString(record.message),
    nonEmptyString(record.reason),
    nonEmptyString(nestedError?.message),
  ];
  return messageCandidates.some((message) => {
    if (!message) {
      return false;
    }
    const lower = message.toLowerCase();
    return OPENCODE_RETRY_ERROR_MESSAGE_FRAGMENTS.some((fragment) => lower.includes(fragment));
  });
}

function safeJsonStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function unwrapOpenCodeSseEvent(raw: unknown): OpenCodeSdkEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.type === "string" &&
    "properties" in r &&
    r.properties &&
    typeof r.properties === "object"
  ) {
    return r as OpenCodeSdkEvent;
  }
  const globalPayload = r.payload;
  if (globalPayload && typeof globalPayload === "object") {
    const p = globalPayload as Record<string, unknown>;
    if (
      typeof p.type === "string" &&
      "properties" in p &&
      p.properties &&
      typeof p.properties === "object"
    ) {
      return p as OpenCodeSdkEvent;
    }
  }
  return null;
}

function readOpenCodeEventSessionId(event: OpenCodeSdkEvent): string | undefined {
  const props = event.properties as Record<string, unknown>;
  return typeof props.sessionID === "string"
    ? props.sessionID
    : typeof props.sessionId === "string"
      ? props.sessionId
      : undefined;
}

function readOpenCodeMessageRole(message: OpenCodeSdkMessage): OpenCodeMessageRole | undefined {
  switch (message.role) {
    case "assistant":
    case "user":
      return message.role;
    default:
      return undefined;
  }
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<OpenCodeSdkPart, "messageID" | "type">,
): OpenCodeMessageRole | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function classifyOpenCodePermission(
  permission: string,
): ProviderRuntimeEventByType<"request.opened">["payload"]["requestType"] {
  const lower = permission.toLowerCase();
  if (lower.includes("shell") || lower.includes("command") || lower.includes("bash")) {
    return "command_execution_approval";
  }
  if (lower.includes("write") || lower.includes("patch") || lower.includes("edit")) {
    return "file_change_approval";
  }
  if (lower.includes("read") || lower.includes("file")) {
    return "file_read_approval";
  }
  return "dynamic_tool_call";
}

export function openCodePermissionRulesForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): PermissionRuleset | undefined {
  if (!isFullAccessRuntimeMode(runtimeMode)) {
    return undefined;
  }
  return [{ permission: "*", pattern: "*", action: "allow" }];
}

export function classifyOpenCodeToolItemType(toolName: string): OpenCodeToolItemType {
  const lower = toolName.toLowerCase();
  if (
    lower.includes("shell") ||
    lower.includes("bash") ||
    lower.includes("command") ||
    lower.includes("terminal") ||
    lower === "exec"
  ) {
    return "command_execution";
  }
  if (
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("patch") ||
    lower.includes("delete") ||
    lower.includes("rename") ||
    lower.includes("move")
  ) {
    return "file_change";
  }
  if (lower.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (lower.includes("web") || lower.includes("search")) {
    return "web_search";
  }
  if (lower.includes("image") || lower.includes("screenshot") || lower.includes("view")) {
    return "image_view";
  }
  if (lower.includes("collab") || lower.includes("subagent") || lower.includes("sub-agent")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

export function mapOpenCodeTodoStatus(
  status: unknown,
): ProviderRuntimeEventByType<"turn.plan.updated">["payload"]["plan"][number]["status"] {
  switch (status) {
    case "completed":
    case "cancelled":
      return "completed";
    case "in_progress":
      return "inProgress";
    case "pending":
    default:
      return "pending";
  }
}

function buildOpenCodeToolDetail(state: OpenCodeSdkToolPart["state"]): string | undefined {
  switch (state.status) {
    case "running":
      return state.title;
    case "completed":
      return state.output;
    case "error":
      return state.error;
    case "pending":
    default:
      return undefined;
  }
}

function openCodeToolStateCreatedAt(state: OpenCodeSdkToolPart["state"]): string | undefined {
  switch (state.status) {
    case "running":
      return openCodeTimestampToIso(state.time.start);
    case "completed":
    case "error":
      return openCodeTimestampToIso(state.time.end);
    case "pending":
    default:
      return undefined;
  }
}

export function rankOpenCodeToolStateStatus(
  status: OpenCodeSdkToolPart["state"]["status"],
): number {
  switch (status) {
    case "pending":
      return 0;
    case "running":
      return 1;
    case "completed":
    case "error":
      return 2;
    default:
      return 0;
  }
}

export function shouldEmitOpenCodeSnapshotDelta(input: {
  hasNativeDelta: boolean;
  previousLength: number;
  nextLength: number;
}): boolean {
  if (input.hasNativeDelta) {
    return false;
  }
  if (input.nextLength < input.previousLength) {
    return false;
  }
  return input.nextLength > input.previousLength;
}

export function appendOnlyDelta(previous: string, next: string): string | undefined {
  if (next.length === 0 || next === previous) {
    return undefined;
  }
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  return next;
}

export function classifyOpenCodeDeltaStreamKind(field: unknown): OpenCodeDeltaStreamKind {
  switch (field) {
    case "reasoning_content":
      return "reasoning_text";
    case "reasoning_details":
      return "reasoning_summary_text";
    default:
      return "assistant_text";
  }
}

export function resolveOpenCodeDeltaStreamKind(input: {
  field: unknown;
  isReasoningPart: boolean;
}): OpenCodeDeltaStreamKind {
  const streamKind = classifyOpenCodeDeltaStreamKind(input.field);
  if (streamKind !== "assistant_text") {
    return streamKind;
  }
  return input.isReasoningPart ? "reasoning_text" : "assistant_text";
}

function mapApprovalDecision(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

function mapQuestions(
  questions: ReadonlyArray<OpenCodeSdkQuestionRequest["questions"][number]>,
): UserInputQuestion[] {
  return questions.map((q, index) => {
    const header =
      typeof q.header === "string" && q.header.trim().length > 0
        ? q.header
        : `Question ${String(index + 1)}`;
    const question =
      typeof q.question === "string" && q.question.trim().length > 0 ? q.question : header;
    const options = q.options.map((option) => ({
      label: option.label,
      description: option.description,
    }));
    return {
      id: `q-${String(index)}`,
      header,
      question,
      options,
      ...(q.multiple === true ? { multiSelect: true } : {}),
    };
  });
}

export function readOpenCodeEventRequestId(
  properties: Record<string, unknown>,
): string | undefined {
  return typeof properties.id === "string"
    ? properties.id
    : typeof properties.requestID === "string"
      ? properties.requestID
      : typeof properties.requestId === "string"
        ? properties.requestId
        : undefined;
}

export function mapOpenCodePermissionReplyDecision(
  reply: unknown,
): ProviderRuntimeEventByType<"request.resolved">["payload"]["decision"] {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    default:
      return "decline";
  }
}

export function mapOpenCodeQuestionAnswers(
  questionIds: ReadonlyArray<string>,
  rawAnswers: unknown,
): ProviderRuntimeEventByType<"user-input.resolved">["payload"]["answers"] {
  if (questionIds.length === 0) {
    return {};
  }
  const answerLists = Array.isArray(rawAnswers)
    ? rawAnswers.map((answer) =>
        Array.isArray(answer) ? answer.map((value) => String(value)) : [String(answer ?? "")],
      )
    : [];
  return Object.fromEntries(
    questionIds.map((questionId, index) => [questionId, answerLists[index] ?? [""]]),
  );
}

function resolveOpenCodeModel(
  modelSelection: ModelSelection | undefined,
  fallbackSlug: string,
  defaults: Record<string, string>,
): { providerID: string; modelID: string } {
  if (modelSelection && modelSelection.provider === PROVIDER) {
    return resolveOpenCodeModelForPrompt({
      modelSlug: modelSelection.model,
      defaults,
    });
  }
  const parsed = parseOpenCodeModelSlug(fallbackSlug);
  if (parsed) return parsed;
  return resolveOpenCodeModelForPrompt({ modelSlug: fallbackSlug, defaults });
}

function resolveOpenCodeVariant(modelSelection: ModelSelection | undefined): string | undefined {
  if (modelSelection?.provider !== PROVIDER) {
    return undefined;
  }
  const variant = modelSelection.options?.variant?.trim();
  return variant && variant.length > 0 ? variant : undefined;
}

const makeOpenCodeAdapter = Effect.fn("makeOpenCodeAdapter")(function* () {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const services = yield* Effect.services();
  const runPromise = Effect.runPromiseWith(services);
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const idleSessionTtlMs = resolveOpenCodeIdleSessionTtlMs();

  const sessions = new Map<ThreadId, OpenCodeSessionContext>();

  const markSessionActive = (ctx: OpenCodeSessionContext): void => {
    ctx.lastActivityAtMs = Date.now();
    clearIdleStopTimer(ctx);
  };

  const scheduleIdleStop = (ctx: OpenCodeSessionContext, reason: string): void => {
    clearIdleStopTimer(ctx);
    if (idleSessionTtlMs === null || ctx.stopped || !canAutoStopSession(ctx)) {
      return;
    }

    ctx.idleStopTimer = setTimeout(() => {
      const latest = sessions.get(ctx.threadId);
      if (latest !== ctx || ctx.stopped || !canAutoStopSession(ctx)) {
        return;
      }
      sessions.delete(ctx.threadId);
      runLoggedEffect({
        runPromise,
        effect: Effect.tryPromise(() => stopContext(ctx)),
        message: "Failed to stop idle OpenCode session.",
        metadata: {
          threadId: ctx.threadId,
          idleTtlMs: idleSessionTtlMs,
          reason,
        },
      });
    }, idleSessionTtlMs);
    ctx.idleStopTimer.unref?.();
  };

  const emit = (event: ProviderRuntimeEvent): void => {
    runLoggedEffect({
      runPromise,
      effect: Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      message: "Failed to emit OpenCode runtime event.",
      metadata: { eventId: event.eventId, threadId: event.threadId, type: event.type },
    });
  };

  const baseEvent = <TType extends ProviderRuntimeEvent["type"]>(
    ctx: OpenCodeSessionContext,
    input: {
      readonly type: TType;
      readonly createdAt?: string | undefined;
      readonly turnId?: TurnId;
      readonly itemId?: RuntimeItemId;
      readonly requestId?: RuntimeRequestId;
      readonly raw?: unknown;
      readonly payload: ProviderRuntimeEventByType<TType>["payload"];
    },
  ): ProviderRuntimeEventByType<TType> => {
    const createdAt = input.createdAt ?? isoNow();
    const timestampMs = parseIsoTimestampMs(createdAt);
    const sessionSequence = (() => {
      if (timestampMs !== undefined) {
        const nextTieBreaker = (ctx.sequenceTieBreakersByTimestampMs.get(timestampMs) ?? 0) + 1;
        ctx.sequenceTieBreakersByTimestampMs.set(timestampMs, nextTieBreaker);
        return timestampMs * 1_000 + nextTieBreaker;
      }
      ctx.nextFallbackSessionSequence += 1;
      return ctx.nextFallbackSessionSequence;
    })();

    return {
      type: input.type,
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: ctx.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.raw !== undefined
        ? {
            raw: {
              source: "opencode.sdk.event" as const,
              payload: input.raw,
            },
          }
        : {}),
      sessionSequence,
      payload: input.payload,
    } as unknown as ProviderRuntimeEventByType<TType>;
  };

  const completeTurn = (
    ctx: OpenCodeSessionContext,
    state: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) => {
    markSessionActive(ctx);
    const activeTurn = ctx.activeTurn;
    const turnId = activeTurn?.id;
    ctx.activeTurn = null;
    ctx.session = {
      ...ctx.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: isoNow(),
      ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
    };
    if (turnId) {
      ctx.replayTurns.push({
        prompt: activeTurn?.inputText ?? "",
        attachmentNames: [...(activeTurn?.attachmentNames ?? [])],
        ...(activeTurn && activeTurn.assistantText.trim().length > 0
          ? { assistantResponse: activeTurn.assistantText }
          : {}),
      });
      for (const reasoningItem of activeTurn?.reasoningItems.values() ?? []) {
        if (reasoningItem.completed) {
          continue;
        }
        reasoningItem.completed = true;
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            turnId,
            itemId: reasoningItem.itemId,
            payload: {
              itemType: "reasoning",
              status: state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }
      for (const toolItem of activeTurn?.toolItems.values() ?? []) {
        if (toolItem.completed) {
          continue;
        }
        toolItem.completed = true;
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            turnId,
            itemId: toolItem.itemId,
            payload: {
              itemType: toolItem.itemType,
              status:
                state === "failed" ? "failed" : state === "interrupted" ? "declined" : "completed",
              ...(toolItem.detail ? { detail: toolItem.detail } : {}),
            },
          }),
        );
      }
      if (activeTurn?.assistantStarted) {
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            turnId,
            itemId: activeTurn.assistantItemId,
            payload: {
              itemType: "assistant_message",
              status: state === "failed" ? "failed" : "completed",
            },
          }),
        );
      }
      const turnUsageSnapshot = buildOpenCodeThreadUsageSnapshot(
        activeTurn?.usage,
        activeTurn?.toolItems.size,
        activeTurn ? Math.max(0, Date.now() - activeTurn.startedAtMs) : undefined,
        currentOpenCodeModelContextWindowTokens(ctx),
      );
      const processedTokens = turnUsageSnapshot?.lastUsedTokens ?? turnUsageSnapshot?.usedTokens;
      if (processedTokens !== undefined && processedTokens > 0) {
        ctx.totalProcessedTokens += processedTokens;
      }
      const usageSnapshot =
        turnUsageSnapshot !== undefined
          ? {
              ...turnUsageSnapshot,
              ...(ctx.totalProcessedTokens > turnUsageSnapshot.usedTokens
                ? { totalProcessedTokens: ctx.totalProcessedTokens }
                : {}),
            }
          : undefined;
      if (usageSnapshot) {
        emit(
          baseEvent(ctx, {
            type: "thread.token-usage.updated",
            turnId,
            payload: {
              usage: usageSnapshot,
            },
          }),
        );
      }
      emit(
        baseEvent(ctx, {
          type: "turn.completed",
          turnId,
          payload: {
            state,
            ...(activeTurn?.usage !== undefined ? { usage: activeTurn.usage } : {}),
            ...(activeTurn?.totalCostUsd !== undefined
              ? { totalCostUsd: activeTurn.totalCostUsd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
        }),
      );
    }
    emit(
      baseEvent(ctx, {
        type: "session.state.changed",
        payload: { state: "ready" },
      }),
    );
    scheduleIdleStop(ctx, "turn-completed");
  };

  const ensureAssistantStarted = (ctx: OpenCodeSessionContext) => {
    const turn = ctx.activeTurn;
    if (!turn || turn.assistantStarted) {
      return;
    }
    turn.assistantStarted = true;
    emit(
      baseEvent(ctx, {
        type: "item.started",
        turnId: turn.id,
        itemId: turn.assistantItemId,
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
        },
      }),
    );
  };

  const ensureReasoningItem = (
    ctx: OpenCodeSessionContext,
    partId: string,
    createdAt?: string | undefined,
  ): {
    turn: NonNullable<OpenCodeSessionContext["activeTurn"]>;
    reasoning: OpenCodeReasoningItemState;
  } | null => {
    const turn = ctx.activeTurn;
    if (!turn) {
      return null;
    }

    let reasoning = turn.reasoningItems.get(partId);
    if (!reasoning) {
      reasoning = {
        itemId: RuntimeItemId.makeUnsafe(`opencode-reasoning:${partId}`),
        lastText: "",
        completed: false,
      };
      turn.reasoningItems.set(partId, reasoning);
      emit(
        baseEvent(ctx, {
          type: "item.started",
          ...(createdAt ? { createdAt } : {}),
          turnId: turn.id,
          itemId: reasoning.itemId,
          payload: {
            itemType: "reasoning",
            status: "inProgress",
          },
        }),
      );
    }

    return { turn, reasoning };
  };

  const emitReasoningDelta = (
    ctx: OpenCodeSessionContext,
    partId: string,
    input: {
      text: string;
      streamKind: Extract<OpenCodeDeltaStreamKind, "reasoning_text" | "reasoning_summary_text">;
      isSnapshot?: boolean;
      createdAt?: string | undefined;
    },
  ) => {
    const state = ensureReasoningItem(ctx, partId, input.createdAt);
    if (!state) {
      return;
    }

    const nextText =
      input.isSnapshot === true ? input.text : `${state.reasoning.lastText}${input.text}`;
    const delta = input.isSnapshot
      ? appendOnlyDelta(state.reasoning.lastText, nextText)
      : input.text.length > 0
        ? input.text
        : undefined;
    state.reasoning.lastText = nextText;
    if (!delta || delta.length === 0) {
      return;
    }

    emit(
      baseEvent(ctx, {
        type: "content.delta",
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
        turnId: state.turn.id,
        itemId: state.reasoning.itemId,
        payload: {
          streamKind: input.streamKind,
          delta,
        },
      }),
    );
  };

  const emitAssistantTextFromSnapshotPart = (
    ctx: OpenCodeSessionContext,
    part: OpenCodeSdkTextPart,
    turnId: TurnId | undefined,
  ) => {
    const turn = ctx.activeTurn;
    if (!turnId || !turn) {
      return;
    }
    const hasNativeDelta = ctx.assistantDeltaPartIds.has(part.id);
    const hasPriorSnapshot = ctx.emittedAssistantTextLengthByPartId.has(part.id);
    const partStartedAtMs = openCodeTimestampToEpochMs(part.time?.start);
    if (partStartedAtMs === undefined && !hasPriorSnapshot) {
      // Ignore timeless snapshots we haven't streamed yet to avoid replaying stale history.
      return;
    }
    if (!isWithinActiveTurnWindow(ctx, partStartedAtMs)) {
      return;
    }
    const previousLength = ctx.emittedAssistantTextLengthByPartId.get(part.id) ?? 0;
    if (
      !shouldEmitOpenCodeSnapshotDelta({
        hasNativeDelta,
        previousLength,
        nextLength: part.text.length,
      })
    ) {
      return;
    }
    const delta = part.text.slice(previousLength);
    if (delta.length === 0) {
      return;
    }
    ctx.emittedAssistantTextLengthByPartId.set(part.id, part.text.length);
    ensureAssistantStarted(ctx);
    turn.assistantText += delta;
    emit(
      baseEvent(ctx, {
        type: "content.delta",
        ...(openCodeTimestampToIso(part.time?.start)
          ? { createdAt: openCodeTimestampToIso(part.time?.start) }
          : {}),
        turnId,
        itemId: turn.assistantItemId,
        payload: {
          streamKind: "assistant_text",
          delta,
        },
      }),
    );
  };

  const handleOpenCodeReasoningPart = (
    ctx: OpenCodeSessionContext,
    part: OpenCodeSdkReasoningPart,
  ) => {
    if (!isWithinActiveTurnWindow(ctx, openCodeTimestampToEpochMs(part.time.start))) {
      return;
    }
    const partId = part.id;
    const text = part.text;
    const reasoningStartedAt =
      openCodeTimestampToIso(part.time.start) ?? openCodeTimestampToIso(part.time.end);
    const reasoningCompletedAt = openCodeTimestampToIso(part.time.end);
    const state = ensureReasoningItem(ctx, partId, reasoningStartedAt);
    if (!state) {
      return;
    }
    const reasoningDeltaInput: Parameters<typeof emitReasoningDelta>[2] = {
      text,
      streamKind: "reasoning_text",
      isSnapshot: true,
    };
    const reasoningDeltaCreatedAt = reasoningStartedAt ?? reasoningCompletedAt;
    if (!ctx.reasoningDeltaPartIds.has(partId) && reasoningDeltaCreatedAt) {
      reasoningDeltaInput.createdAt = reasoningDeltaCreatedAt;
    }
    if (!ctx.reasoningDeltaPartIds.has(partId)) {
      emitReasoningDelta(ctx, partId, reasoningDeltaInput);
    }

    if (part.time.end !== undefined && !state.reasoning.completed) {
      state.reasoning.completed = true;
      emit(
        baseEvent(ctx, {
          type: "item.completed",
          ...(reasoningCompletedAt ? { createdAt: reasoningCompletedAt } : {}),
          turnId: state.turn.id,
          itemId: state.reasoning.itemId,
          payload: {
            itemType: "reasoning",
            status: "completed",
          },
        }),
      );
    }
  };

  const handleOpenCodeToolPart = (ctx: OpenCodeSessionContext, part: OpenCodeSdkToolPart) => {
    const turn = ctx.activeTurn;
    if (!turn) {
      return;
    }
    const toolStartedAtMs = (() => {
      switch (part.state.status) {
        case "running":
          return openCodeTimestampToEpochMs(part.state.time.start);
        case "completed":
        case "error":
          return openCodeTimestampToEpochMs(part.state.time.start);
        case "pending":
        default:
          return undefined;
      }
    })();
    if (!isWithinActiveTurnWindow(ctx, toolStartedAtMs)) {
      return;
    }
    const partId = part.id;
    const toolName = part.tool;
    const state = part.state;
    const stateStatus = state.status;
    const stateRank = rankOpenCodeToolStateStatus(stateStatus);
    const itemType = classifyOpenCodeToolItemType(toolName);
    const detail = buildOpenCodeToolDetail(state);
    const data = {
      partId,
      tool: toolName,
      messageId: part.messageID,
      callId: part.callID,
      ...(state ? { state } : {}),
      ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
    };

    let toolItem = turn.toolItems.get(partId);
    if (!toolItem) {
      toolItem = {
        itemId: RuntimeItemId.makeUnsafe(`opencode-tool:${partId}`),
        itemType,
        statusRank: stateRank,
        completed: false,
        ...(detail ? { detail } : {}),
      };
      turn.toolItems.set(partId, toolItem);
      emit(
        baseEvent(ctx, {
          type: "item.started",
          ...(openCodeToolStateCreatedAt(state)
            ? { createdAt: openCodeToolStateCreatedAt(state) }
            : {}),
          turnId: turn.id,
          itemId: toolItem.itemId,
          payload: {
            itemType,
            status: "inProgress",
            title: toolName,
            ...(detail ? { detail } : {}),
            data,
          },
        }),
      );
    } else {
      if (stateRank < toolItem.statusRank) {
        return;
      }
      toolItem.statusRank = stateRank;
      if (detail) {
        toolItem.detail = detail;
      } else {
        delete toolItem.detail;
      }
    }

    if (stateStatus === "completed" || stateStatus === "error") {
      if (!toolItem.completed) {
        toolItem.completed = true;
        emit(
          baseEvent(ctx, {
            type: "item.completed",
            ...(openCodeToolStateCreatedAt(state)
              ? { createdAt: openCodeToolStateCreatedAt(state) }
              : {}),
            turnId: turn.id,
            itemId: toolItem.itemId,
            payload: {
              itemType,
              status: stateStatus === "error" ? "failed" : "completed",
              title: toolName,
              ...(detail ? { detail } : {}),
              data,
            },
          }),
        );
      }
      return;
    }

    emit(
      baseEvent(ctx, {
        type: "item.updated",
        ...(openCodeToolStateCreatedAt(state)
          ? { createdAt: openCodeToolStateCreatedAt(state) }
          : {}),
        turnId: turn.id,
        itemId: toolItem.itemId,
        payload: {
          itemType,
          status: "inProgress",
          title: toolName,
          ...(detail ? { detail } : {}),
          data,
        },
      }),
    );
  };

  const handleSsePayload = (ctx: OpenCodeSessionContext, raw: unknown) => {
    if (ctx.stopped) return;
    const event = unwrapOpenCodeSseEvent(raw);
    if (!event) return;
    const sessionId = readOpenCodeEventSessionId(event);
    if (sessionId && sessionId !== ctx.opencodeSessionId) {
      return;
    }
    markSessionActive(ctx);
    const sseEvent = <TType extends ProviderRuntimeEvent["type"]>(input: {
      readonly type: TType;
      readonly createdAt?: string | undefined;
      readonly turnId?: TurnId;
      readonly itemId?: RuntimeItemId;
      readonly requestId?: RuntimeRequestId;
      readonly payload: ProviderRuntimeEventByType<TType>["payload"];
    }): ProviderRuntimeEventByType<TType> => baseEvent(ctx, { ...input, raw: event });

    switch (event.type) {
      case "message.updated": {
        const role = readOpenCodeMessageRole(event.properties.info);
        if (!role) {
          return;
        }
        const messageId = event.properties.info.id;
        ctx.messageRoleById.set(messageId, role);
        return;
      }
      case "message.removed": {
        ctx.messageRoleById.delete(event.properties.messageID);
        for (const [partId, part] of ctx.partById) {
          if (part.messageID !== event.properties.messageID) {
            continue;
          }
          ctx.partById.delete(partId);
          ctx.emittedAssistantTextLengthByPartId.delete(partId);
          ctx.assistantDeltaPartIds.delete(partId);
          ctx.reasoningDeltaPartIds.delete(partId);
        }
        return;
      }
      case "message.part.removed": {
        ctx.partById.delete(event.properties.partID);
        ctx.emittedAssistantTextLengthByPartId.delete(event.properties.partID);
        ctx.assistantDeltaPartIds.delete(event.properties.partID);
        ctx.reasoningDeltaPartIds.delete(event.properties.partID);
        return;
      }
      case "message.part.delta": {
        const { delta, field, partID } = event.properties;
        const turnId = ctx.activeTurn?.id;
        if (!turnId || !ctx.activeTurn) return;
        if (delta.length === 0) {
          return;
        }
        const part = ctx.partById.get(partID);
        const role = part ? messageRoleForPart(ctx, part) : undefined;
        if (role === "user") {
          return;
        }
        const streamKind = resolveOpenCodeDeltaStreamKind({
          field,
          isReasoningPart:
            (part ? part.type === "reasoning" : false) || ctx.activeTurn.reasoningItems.has(partID),
        });
        if (streamKind === "assistant_text") {
          ctx.assistantDeltaPartIds.add(partID);
          ensureAssistantStarted(ctx);
          ctx.activeTurn.assistantText += delta;
          const previousLength = ctx.emittedAssistantTextLengthByPartId.get(partID) ?? 0;
          ctx.emittedAssistantTextLengthByPartId.set(partID, previousLength + delta.length);
          emit(
            sseEvent({
              type: "content.delta",
              turnId,
              itemId: ctx.activeTurn.assistantItemId,
              payload: {
                streamKind,
                delta,
              },
            }),
          );
          return;
        }

        ctx.reasoningDeltaPartIds.add(partID);
        const reasoningDeltaCreatedAt =
          part?.type === "reasoning" ? resolveOpenCodePartTimestamp(part, "start") : undefined;
        emitReasoningDelta(ctx, partID, {
          text: delta,
          streamKind,
          ...(reasoningDeltaCreatedAt ? { createdAt: reasoningDeltaCreatedAt } : {}),
        });
        return;
      }
      case "message.part.updated": {
        const part = event.properties.part;
        ctx.partById.set(part.id, part);
        const turnId = ctx.activeTurn?.id;
        appendTurnItem(ctx, turnId, part);
        switch (part.type) {
          case "text": {
            if (messageRoleForPart(ctx, part) !== "assistant") {
              return;
            }
            emitAssistantTextFromSnapshotPart(ctx, part, turnId);
            return;
          }
          case "reasoning":
            handleOpenCodeReasoningPart(ctx, part);
            return;
          case "tool":
            handleOpenCodeToolPart(ctx, part);
            return;
          case "step-finish": {
            if (!ctx.activeTurn) {
              return;
            }
            ctx.activeTurn.usage = part.tokens;
            if (Number.isFinite(part.cost)) {
              ctx.activeTurn.totalCostUsd = part.cost;
            }
            return;
          }
          default:
            return;
        }
      }
      case "todo.updated": {
        const turnId = ctx.activeTurn?.id;
        if (!turnId) {
          return;
        }
        const todos = event.properties.todos
          .map((todo) => {
            const step = nonEmptyString(todo.content);
            if (!step) {
              return null;
            }
            return {
              step,
              status: mapOpenCodeTodoStatus(todo.status),
            };
          })
          .filter(
            (
              entry,
            ): entry is {
              readonly step: string;
              readonly status: "pending" | "inProgress" | "completed";
            } => entry !== null,
          );
        emit(
          sseEvent({
            type: "turn.plan.updated",
            turnId,
            payload: {
              plan: todos,
            },
          }),
        );
        return;
      }
      case "session.status": {
        const status = event.properties.status;
        if (status.type !== "retry") {
          return;
        }
        const message = nonEmptyString(status.message) ?? "OpenCode is retrying the request.";
        const detail = safeJsonStringify(status);
        if (isOpenCodeRetryStatusError(status)) {
          emit(
            sseEvent({
              type: "runtime.error",
              ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
              payload: buildRuntimeErrorPayload({
                message,
                detail,
                class: "provider_error",
              }),
            }),
          );
          return;
        }
        emit(
          sseEvent({
            type: "runtime.warning",
            ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
            payload: buildRuntimeWarningPayload(message, detail),
          }),
        );
        return;
      }
      case "session.compacted": {
        emit(
          sseEvent({
            type: "thread.state.changed",
            payload: {
              state: "compacted",
              detail: event.properties,
            },
          }),
        );
        return;
      }
      case "session.updated": {
        const info = event.properties.info;
        const title = nonEmptyString(info.title);
        if (!title) {
          return;
        }
        emit(
          sseEvent({
            type: "thread.metadata.updated",
            payload: {
              name: title,
              metadata: info as Record<string, unknown>,
            },
          }),
        );
        return;
      }
      case "session.idle": {
        completeTurn(ctx, "completed");
        return;
      }
      case "session.error": {
        const err = event.properties.error;
        const msg = toMessage(err, "OpenCode session error");
        completeTurn(ctx, "failed", msg);
        emit(
          sseEvent({
            type: "runtime.error",
            payload: buildRuntimeErrorPayload({
              message: msg,
              detail: err !== undefined && err !== null ? err : undefined,
              class: "provider_error",
            }),
          }),
        );
        return;
      }
      case "permission.asked": {
        const request: OpenCodeSdkPermissionRequest = event.properties;
        const requestId = request.id;
        if (!requestId) return;
        const permission = request.permission;
        const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
        ctx.pendingApprovals.set(requestId, {
          requestId: runtimeRequestId,
          requestType: classifyOpenCodePermission(permission),
          ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
        });
        emit(
          sseEvent({
            type: "request.opened",
            ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
            requestId: runtimeRequestId,
            payload: {
              requestType: classifyOpenCodePermission(permission),
              detail: request.patterns.length > 0 ? request.patterns.join("\n") : permission,
              args: request.metadata,
            },
          }),
        );
        return;
      }
      case "permission.replied": {
        const requestId = readOpenCodeEventRequestId(event.properties);
        if (!requestId) {
          return;
        }
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return;
        }
        ctx.pendingApprovals.delete(requestId);
        emit(
          sseEvent({
            type: "request.resolved",
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId: pending.requestId,
            payload: {
              requestType: pending.requestType,
              decision: mapOpenCodePermissionReplyDecision(event.properties.reply),
            },
          }),
        );
        scheduleIdleStop(ctx, "permission-replied");
        return;
      }
      case "question.asked": {
        const request: OpenCodeSdkQuestionRequest = event.properties;
        const requestId = request.id;
        if (!requestId) return;
        const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
        const questions = mapQuestions(request.questions);
        ctx.pendingUserInputs.set(requestId, {
          requestId: runtimeRequestId,
          ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
          questionIds: questions.map((question) => question.id),
        });
        emit(
          sseEvent({
            type: "user-input.requested",
            ...(ctx.activeTurn ? { turnId: ctx.activeTurn.id } : {}),
            requestId: runtimeRequestId,
            payload: {
              questions,
            },
          }),
        );
        return;
      }
      case "question.replied": {
        const requestId = readOpenCodeEventRequestId(event.properties);
        if (!requestId) {
          return;
        }
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return;
        }
        ctx.pendingUserInputs.delete(requestId);
        emit(
          sseEvent({
            type: "user-input.resolved",
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId: pending.requestId,
            payload: {
              answers: mapOpenCodeQuestionAnswers(pending.questionIds, event.properties.answers),
            },
          }),
        );
        scheduleIdleStop(ctx, "question-replied");
        return;
      }
      case "question.rejected": {
        const requestId = readOpenCodeEventRequestId(event.properties);
        if (!requestId) {
          return;
        }
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return;
        }
        ctx.pendingUserInputs.delete(requestId);
        emit(
          sseEvent({
            type: "user-input.resolved",
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId: pending.requestId,
            payload: {
              answers: {},
            },
          }),
        );
        scheduleIdleStop(ctx, "question-rejected");
        return;
      }
      default:
        return;
    }
  };

  const startSse = (ctx: OpenCodeSessionContext) => {
    const ac = new AbortController();
    ctx.sseAbort = ac;
    void (async () => {
      try {
        const sub = await ctx.client.event.subscribe({
          directory: ctx.cwd,
        });
        for await (const raw of sub.stream) {
          if (ac.signal.aborted || ctx.stopped) break;
          handleSsePayload(ctx, raw);
        }
      } catch (cause) {
        if (!ctx.stopped) {
          emit(
            baseEvent(ctx, {
              type: "runtime.error",
              payload: buildRuntimeErrorPayload({
                message: toMessage(cause, "OpenCode event stream failed"),
                cause,
                class: "transport_error",
              }),
            }),
          );
        }
      }
    })();
  };

  const startSession: OpenCodeAdapterShape["startSession"] = (input: ProviderSessionStartInput) =>
    Effect.tryPromise({
      try: async () => {
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected OpenCode model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) {
          markSessionActive(existing);
          scheduleIdleStop(existing, "session-reused");
          return existing.session;
        }

        const settings = await runPromise(serverSettingsService.getSettings);
        const binaryPath = settings.providers.opencode.binaryPath;
        const server = await startOpenCodeServerIsolated(binaryPath);
        const cwd = input.cwd ?? serverConfig.cwd;
        const client = createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: cwd,
        });
        try {
          const listed = await client.config.providers();
          if (listed.error) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "config.providers",
              detail: toMessage(listed.error, "Failed to list OpenCode providers"),
            });
          }
          const body = listed.data as OpenCodeConfigProvidersResponse | undefined;
          if (!body || !Array.isArray(body.providers)) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "config.providers",
              detail: "Unexpected OpenCode provider catalog response.",
            });
          }
          const defaultModels = body.default ?? {};
          const listedCommands = await client.command.list({ directory: cwd }).catch(() => null);
          const availableCommands = mergeProviderSlashCommands(
            listedCommands?.error ? [] : normalizeOpenCodeAvailableCommands(listedCommands?.data),
            providerFallbackSlashCommands(PROVIDER),
          );

          const createSession = async (): Promise<string> => {
            const permission = openCodePermissionRulesForRuntimeMode(input.runtimeMode);
            const created = await client.session.create({
              directory: cwd,
              ...(input.threadTitle ? { title: input.threadTitle } : {}),
              ...(permission ? { permission } : {}),
            });
            if (created.error || !created.data) {
              throw new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.create",
                detail: toMessage(created.error, "Failed to create OpenCode session"),
              });
            }
            return created.data.id;
          };

          const resumeSessionId = readOpenCodeResumeSessionId(input.resumeCursor);
          let opencodeSessionId: string;
          let resumedExistingSession = false;
          if (resumeSessionId) {
            const resumed = await client.session.get({
              sessionID: resumeSessionId,
              directory: cwd,
            });
            if (resumed.error) {
              if (!isMissingOpenCodeSessionError(resumed.error)) {
                throw new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session.get",
                  detail: toMessage(resumed.error, "Failed to resume OpenCode session"),
                });
              }
              opencodeSessionId = await createSession();
            } else if (!resumed.data) {
              throw new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.get",
                detail: "OpenCode did not return session details for resume.",
              });
            } else {
              opencodeSessionId = resumeSessionId;
              resumedExistingSession = true;
            }
          } else {
            opencodeSessionId = await createSession();
          }

          const raceWinner = sessions.get(input.threadId);
          if (raceWinner) {
            if (!resumedExistingSession) {
              await client.session
                .delete({
                  sessionID: opencodeSessionId,
                  directory: cwd,
                })
                .catch(() => undefined);
            }
            await server.close().catch(() => undefined);
            return raceWinner.session;
          }

          const createdAt = isoNow();
          const model =
            input.modelSelection && input.modelSelection.provider === PROVIDER
              ? input.modelSelection.model
              : DEFAULT_MODEL_BY_PROVIDER.opencode;

          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model,
            threadId: input.threadId,
            resumeCursor: {
              sessionId: opencodeSessionId,
            },
            createdAt,
            updatedAt: createdAt,
          };

          const ctx: OpenCodeSessionContext = {
            threadId: input.threadId,
            session,
            cwd,
            server,
            client,
            opencodeSessionId,
            opencodeBaseUrl: server.url,
            defaultModels,
            modelCatalog: body,
            turns: [],
            replayTurns: cloneReplayTurns(input.replayTurns),
            totalProcessedTokens: 0,
            sequenceTieBreakersByTimestampMs: new Map(),
            nextFallbackSessionSequence: 0,
            activeTurn: null,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            messageRoleById: new Map(),
            partById: new Map(),
            emittedAssistantTextLengthByPartId: new Map(),
            assistantDeltaPartIds: new Set(),
            reasoningDeltaPartIds: new Set(),
            sseAbort: null,
            idleStopTimer: null,
            lastActivityAtMs: Date.now(),
            pendingBootstrapReset: (input.replayTurns?.length ?? 0) > 0 && !resumedExistingSession,
            stopped: false,
          };
          sessions.set(input.threadId, ctx);
          startSse(ctx);

          emit(
            baseEvent(ctx, {
              type: "session.started",
              payload: resumedExistingSession ? { resume: session.resumeCursor } : {},
            }),
          );
          emit(
            baseEvent(ctx, {
              type: "session.configured",
              payload: {
                config: {
                  availableCommands,
                },
              },
              raw: {
                method: "command.list",
                availableCommands,
              },
            }),
          );
          emit(
            baseEvent(ctx, {
              type: "thread.started",
              payload: { providerThreadId: opencodeSessionId },
            }),
          );
          scheduleIdleStop(ctx, "session-started");
          return ctx.session;
        } catch (cause) {
          try {
            await server.close();
          } catch (cleanupCause) {
            throw new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: `${toMessage(cause, "OpenCode session start failed")} Cleanup also failed: ${toMessage(
                cleanupCause,
                "Failed to stop OpenCode server",
              )}`,
              cause: new AggregateError([cause, cleanupCause]),
            });
          }
          throw cause;
        }
      },
      catch: (cause) =>
        isProviderAdapterValidationError(cause) || isProviderAdapterRequestError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "startSession",
              detail: toMessage(cause, "OpenCode session start failed"),
              cause,
            }),
    });

  const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
    Effect.tryPromise({
      try: async () => {
        const ctx = sessions.get(input.threadId);
        if (!ctx) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Expected OpenCode model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        if (ctx.activeTurn) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt_async",
            detail: "OpenCode session already has an active turn.",
          });
        }

        const turnId = TurnId.makeUnsafe(`opencode-turn:${randomUUID()}`);
        const assistantItemId = RuntimeItemId.makeUnsafe(`opencode-assistant:${randomUUID()}`);
        const selectedModelSlug =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.model
            : (ctx.session.model ?? DEFAULT_MODEL_BY_PROVIDER.opencode);
        const modelIds = resolveOpenCodeModel(
          input.modelSelection,
          selectedModelSlug,
          ctx.defaultModels,
        );
        const variant = resolveOpenCodeVariant(input.modelSelection);

        ctx.activeTurn = {
          id: turnId,
          startedAtMs: Date.now(),
          inputText: input.input ?? "",
          attachmentNames: (input.attachments ?? []).map((attachment) => attachment.name),
          assistantText: "",
          assistantItemId,
          assistantStarted: false,
          toolItems: new Map(),
          reasoningItems: new Map(),
        };
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: isoNow(),
          model: selectedModelSlug,
        };

        emit(
          baseEvent(ctx, {
            type: "turn.started",
            turnId,
            payload: { model: selectedModelSlug },
          }),
        );

        const parts: Array<
          | { type: "text"; text: string }
          | { type: "file"; mime: string; url: string; filename?: string }
        > = [];

        const promptText = ctx.pendingBootstrapReset
          ? buildBootstrapPromptFromReplayTurns(
              ctx.replayTurns,
              input.input ?? "Please analyze the attached files.",
              ROLLBACK_BOOTSTRAP_MAX_CHARS,
            ).text
          : input.input;

        if (promptText && promptText.trim().length > 0) {
          parts.push({ type: "text", text: promptText });
        }

        const attachments = (input.attachments ?? [])
          .map((attachment) => {
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path) return null;
            return { path, name: attachment.name };
          })
          .filter((a): a is { path: string; name: string } => a !== null);

        for (const attachment of attachments) {
          parts.push({
            type: "file",
            mime: "application/octet-stream",
            url: pathToFileURL(attachment.path).href,
            filename: attachment.name,
          });
        }

        if (parts.length === 0) {
          parts.push({ type: "text", text: " " });
        }

        const prompt = await ctx.client.session.promptAsync({
          sessionID: ctx.opencodeSessionId,
          directory: ctx.cwd,
          model: modelIds,
          ...(variant ? { variant } : {}),
          parts,
        });

        if (prompt.error) {
          completeTurn(ctx, "failed", toMessage(prompt.error, "OpenCode prompt failed"));
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session.prompt_async",
            detail: toMessage(prompt.error, "OpenCode prompt failed"),
          });
        }

        ctx.pendingBootstrapReset = false;
        ctx.turns.push({ id: turnId, items: [] });
        return {
          threadId: input.threadId,
          turnId,
        } satisfies ProviderTurnStartResult;
      },
      catch: (cause) =>
        isProviderAdapterValidationError(cause) ||
        isProviderAdapterRequestError(cause) ||
        isProviderAdapterSessionNotFoundError(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: toMessage(cause, "OpenCode sendTurn failed"),
              cause,
            }),
    });

  const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId: ThreadId) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const result = await ctx.client.session.abort({
        sessionID: ctx.opencodeSessionId,
        directory: ctx.cwd,
      });
      if (result.error) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.abort",
          detail: toMessage(result.error, "OpenCode abort failed"),
        });
      }
      completeTurn(ctx, "interrupted");
    });

  const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const reply = mapApprovalDecision(decision);
      const res = await ctx.client.permission.reply({
        requestID: requestId,
        directory: ctx.cwd,
        reply,
      });
      if (res.error) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: toMessage(res.error, "OpenCode permission reply failed"),
        });
      }
      const pending = ctx.pendingApprovals.get(requestId);
      ctx.pendingApprovals.delete(requestId);
      emit(
        baseEvent(ctx, {
          type: "request.resolved",
          ...(pending?.turnId ? { turnId: pending.turnId } : {}),
          requestId: pending?.requestId ?? RuntimeRequestId.makeUnsafe(requestId),
          payload: {
            requestType: pending?.requestType ?? "dynamic_tool_call",
            decision,
          },
        }),
      );
    });

  const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
    threadId: ThreadId,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const sortedKeys = Object.keys(answers).toSorted((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      );
      const answerArrays: string[][] = sortedKeys.map((key) => {
        const v = answers[key];
        if (Array.isArray(v)) return v.map((x) => String(x));
        return [String(v ?? "")];
      });
      const res = await ctx.client.question.reply({
        requestID: requestId,
        directory: ctx.cwd,
        answers: answerArrays,
      });
      if (res.error) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: toMessage(res.error, "OpenCode question reply failed"),
        });
      }
      const pending = ctx.pendingUserInputs.get(requestId);
      ctx.pendingUserInputs.delete(requestId);
      emit(
        baseEvent(ctx, {
          type: "user-input.resolved",
          ...(pending?.turnId ? { turnId: pending.turnId } : {}),
          requestId: pending?.requestId ?? RuntimeRequestId.makeUnsafe(requestId),
          payload: {
            answers,
          },
        }),
      );
    });

  const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId: ThreadId) =>
    Effect.tryPromise(async () => {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      sessions.delete(threadId);
      await stopContext(ctx);
    });

  const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

  const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId: ThreadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: OpenCodeAdapterShape["readThread"] = (threadId: ThreadId) =>
    Effect.sync(() => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return {
        threadId,
        turns: ctx.turns.map((t) => ({ id: t.id, items: [...t.items] })),
      };
    });

  const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const ctx = sessions.get(threadId);
      if (!ctx) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (ctx.activeTurn) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "OpenCode cannot roll back while a turn is still running.",
        });
      }

      const nextLength = Math.max(0, ctx.turns.length - numTurns);
      const trimmedTurns = ctx.turns.slice(0, nextLength).map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      }));
      const trimmedReplayTurns = ctx.replayTurns.slice(0, nextLength).map((turn) => {
        if (turn.assistantResponse !== undefined) {
          return {
            prompt: turn.prompt,
            attachmentNames: [...turn.attachmentNames],
            assistantResponse: turn.assistantResponse,
          };
        }

        return {
          prompt: turn.prompt,
          attachmentNames: [...turn.attachmentNames],
        };
      });

      const restartInput = {
        provider: PROVIDER,
        threadId,
        runtimeMode: ctx.session.runtimeMode,
        ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
        ...(ctx.session.model
          ? {
              modelSelection: {
                provider: PROVIDER,
                model: ctx.session.model,
              } as const,
            }
          : {}),
      };

      yield* stopSession(threadId);
      yield* startSession(restartInput);

      const restarted = sessions.get(threadId);
      if (!restarted) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "OpenCode rollback failed to recreate the session.",
        });
      }

      restarted.turns.push(...trimmedTurns);
      restarted.replayTurns.push(...trimmedReplayTurns);
      restarted.pendingBootstrapReset = trimmedReplayTurns.length > 0;

      return {
        threadId,
        turns: restarted.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    },
  );

  const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
    Effect.tryPromise(async () => {
      for (const [threadId, ctx] of sessions) {
        sessions.delete(threadId);
        await stopContext(ctx);
      }
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      sessionModelOptionsSwitch: "in-session",
      liveTurnDiffMode: "workspace",
      reviewChangesMode: "git",
      reviewSurface: "git-worktree",
      approvalRequestsMode: "native",
      turnSteeringMode: "queued-message",
      transcriptAuthority: "local",
      historyAuthority: "local-server-session",
      sessionResumeMode: "local-replay",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies OpenCodeAdapterShape;
});

export const OpenCodeAdapterLive = Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter());
