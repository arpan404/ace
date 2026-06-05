/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import { randomUUID } from "node:crypto";
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderSlashCommand,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  EventId,
  ProviderApprovalDecision,
  ProviderItemId,
  ThreadId,
  TurnId,
  ProviderSendTurnInput,
} from "@ace/contracts";
import { Effect, FileSystem, Layer, Queue, Schema, ServiceMap, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  asFiniteNumber as asNumber,
  asObject,
  asReadonlyArray as asArray,
  asString,
} from "../unknown.ts";
import { meaningfulErrorMessage } from "../errorCause.ts";
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
import { resolveProviderSettings } from "@ace/shared/providerInstances";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { discoverCodexExtensionSlashCommands } from "../providerExtensionSlashCommands.ts";
import { CODEX_GOAL_SLASH_COMMAND } from "../codexGoalFeature.ts";
import {
  CodexAppServerManager,
  type CodexGoalStatus,
  type CodexAppServerStartSessionInput,
} from "../../codexAppServerManager.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "codex" as const;
const ROLLBACK_BOOTSTRAP_MAX_CHARS = 24_000;
const CODEX_PROVIDER_CAPABILITIES = {
  sessionForkMode: "native" as const,
  sideConversationMode: "native-fork" as const,
  providerThreadTargetingMode: "native" as const,
  goalControlMode: "native" as const,
};

export interface CodexAdapterLiveOptions {
  readonly manager?: CodexAppServerManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CodexAppServerManager;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly resolveGoalsFeatureEnabled?: () => boolean;
}

interface CodexReplayBootstrapState {
  readonly replayTurns: Array<TranscriptReplayTurn>;
  pendingBootstrapReset: boolean;
}

const toMessage = meaningfulErrorMessage;

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];
const SESSION_CONFIG_COMMAND_KEYS = [
  "availableCommands",
  "available_commands",
  "slashCommands",
  "slash_commands",
  "commands",
] as const;

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function readSessionConfigCommandEntries(value: unknown): ReadonlyArray<unknown> | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asObject(value);
  if (!record) {
    return undefined;
  }

  for (const key of SESSION_CONFIG_COMMAND_KEYS) {
    const entries = asArray(record[key]);
    if (entries) {
      return entries;
    }
  }
  return undefined;
}

function readSessionConfiguredCommandEntries(
  payload: Record<string, unknown> | undefined,
): ReadonlyArray<unknown> | undefined {
  if (!payload) {
    return undefined;
  }

  return (
    readSessionConfigCommandEntries(payload) ??
    readSessionConfigCommandEntries(payload.config) ??
    readSessionConfigCommandEntries(payload.session) ??
    readSessionConfigCommandEntries(asObject(payload.session)?.config)
  );
}

function mergeSessionConfiguredCommandEntries(
  providerCommands: ReadonlyArray<unknown> | undefined,
  extensionCommands: ReadonlyArray<ProviderSlashCommand>,
): ReadonlyArray<unknown> | undefined {
  if (providerCommands === undefined) {
    return extensionCommands.length > 0 ? extensionCommands : undefined;
  }
  if (extensionCommands.length === 0) {
    return providerCommands;
  }
  return [...providerCommands, ...extensionCommands];
}

interface ParsedCodexGoalCommand {
  readonly action: "get" | "set" | "clear" | "pause" | "resume";
  readonly objective?: string;
  readonly tokenBudget?: number;
}

const COMPOSER_PROVIDER_COMMAND_MARKER = "\u2064";
const CODEX_GOAL_MAX_OBJECTIVE_CHARS = 4_000;

function stripProviderCommandMarkers(text: string): string {
  return text.replaceAll(COMPOSER_PROVIDER_COMMAND_MARKER, "");
}

function parseCodexGoalCommand(input: string | undefined): ParsedCodexGoalCommand | null {
  const text = stripProviderCommandMarkers(input ?? "").trim();
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(text);
  if (!match) {
    return null;
  }
  const body = (match[1] ?? "").trim();
  if (!body) {
    return { action: "get" };
  }
  const normalized = body.toLowerCase();
  if (normalized === "clear") {
    return { action: "clear" };
  }
  if (normalized === "pause") {
    return { action: "pause" };
  }
  if (normalized === "resume") {
    return { action: "resume" };
  }
  const budgetMatch = /\s+--token-budget\s+(\d+)\s*$/iu.exec(body);
  const tokenBudget = budgetMatch?.[1] ? Number.parseInt(budgetMatch[1], 10) : undefined;
  const objective = (budgetMatch ? body.slice(0, budgetMatch.index) : body).trim();
  return objective ? { action: "set", objective, ...(tokenBudget ? { tokenBudget } : {}) } : null;
}

function goalStatusForCommand(action: ParsedCodexGoalCommand["action"]): CodexGoalStatus {
  return action === "pause" ? "paused" : "active";
}

function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asObject(value);
  const totalUsage = asObject(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asObject(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens);
  const usedTokens =
    asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.model_context_window) ?? asNumber(usage?.modelContextWindow);
  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens);
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

function toProcessPid(value: unknown): number | undefined {
  const pid = asNumber(asObject(value)?.processPid);
  return pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function isImageGenerationItem(source: Record<string, unknown>): boolean {
  return normalizeItemType(source.type ?? source.kind).includes("image generation");
}

function imageGenerationAssistantLifecycleEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.completed",
): ProviderRuntimeEvent {
  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType: "assistant_message",
      status: lifecycle === "item.started" ? "inProgress" : "completed",
      title: "Assistant message",
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemTitleForSource(
  itemType: CanonicalItemType,
  source: Record<string, unknown>,
): string | undefined {
  const normalizedType = normalizeItemType(source.type ?? source.kind);
  if (normalizedType.includes("image generation")) {
    return "Image generation";
  }
  if (itemType === "file_change") {
    const detail = itemDetail(source, source)?.trim().toLowerCase();
    if (
      detail === "read" ||
      detail === "read file" ||
      detail === "open file" ||
      detail === "view file"
    ) {
      return "Read file";
    }
  }
  return itemTitle(itemType);
}

function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(item.revisedPrompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function codexLifecycleOutput(source: Record<string, unknown>): string | undefined {
  const result = asObject(source.result);
  return (
    asString(source.output) ??
    asString(source.aggregatedOutput) ??
    asString(source.stdout) ??
    asString(source.stderr) ??
    asString(result?.output) ??
    asString(result?.aggregatedOutput) ??
    asString(result?.stdout) ??
    asString(result?.stderr)
  );
}

function codexLifecycleCwd(
  source: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const input = asObject(source.input) ?? asObject(source.arguments);
  return (
    asString(source.cwd) ??
    asString(payload.cwd) ??
    asString(input?.cwd) ??
    asString(input?.workingDirectory)
  );
}

function normalizeCodexLifecycleData(
  payload: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const input = asObject(source.input) ?? asObject(source.arguments);
  const command =
    asString(source.command) ??
    asString(payload.command) ??
    asString(input?.command) ??
    asString(input?.cmd);
  const cwd = codexLifecycleCwd(source, payload);
  const output = codexLifecycleOutput(source);
  return {
    ...payload,
    ...(input ? { input, arguments: input } : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(output ? { output, aggregatedOutput: output } : {}),
    item: {
      ...source,
      ...(input ? { input, arguments: input } : {}),
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(output ? { output, aggregatedOutput: output } : {}),
    },
  };
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      if (typeof value === "string") {
        return [[questionId, value] as const];
      }

      if (Array.isArray(value)) {
        const normalized = value.filter((entry): entry is string => typeof entry === "string");
        return [[questionId, normalized.length === 1 ? normalized[0] : normalized] as const];
      }

      const answerObject = asObject(value);
      const answerList = asArray(answerObject?.answers)?.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!answerList) {
        return [];
      }
      return [[questionId, answerList.length === 1 ? answerList[0] : answerList] as const];
    }),
  );
}

function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions
    .map((entry) => {
      const question = asObject(entry);
      if (!question) return undefined;
      const options = asArray(question.options)
        ?.map((option) => {
          const optionRecord = asObject(option);
          if (!optionRecord) return undefined;
          const label = asString(optionRecord.label)?.trim();
          const description = asString(optionRecord.description)?.trim();
          if (!label || !description) {
            return undefined;
          }
          return { label, description };
        })
        .filter((option): option is { label: string; description: string } => option !== undefined);
      const id = asString(question.id)?.trim();
      const header = asString(question.header)?.trim();
      const prompt = asString(question.question)?.trim();
      if (!id || !header || !prompt || !options || options.length === 0) {
        return undefined;
      }
      const parsedQuestion: {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: true;
      } = {
        id,
        header,
        question: prompt,
        options,
      };
      if (question.multiSelect === true) {
        parsedQuestion.multiSelect = true;
      }
      return parsedQuestion;
    })
    .filter(
      (
        question,
      ): question is {
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: true;
      } => question !== undefined,
    );

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(source, payload ?? {});
  const title = itemTitleForSource(itemType, source);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...(payload ? { data: normalizeCodexLifecycleData(payload, source) } : {}),
    },
  };
}

function hookOutputText(run: Record<string, unknown> | undefined): string | undefined {
  const entries = asArray(run?.entries);
  if (!entries) {
    return undefined;
  }

  const text = entries
    .map((entry) => asString(asObject(entry)?.text)?.trim())
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function hookOutcome(value: unknown): "success" | "error" | "cancelled" {
  switch (asString(value)) {
    case "completed":
      return "success";
    case "stopped":
      return "cancelled";
    case "failed":
    case "blocked":
    default:
      return "error";
  }
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  availableCommands: ReadonlyArray<ProviderSlashCommand> = providerFallbackSlashCommands(PROVIDER),
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: buildRuntimeErrorPayload({
          message: event.message,
          detail: event.payload,
          class: "provider_error",
        }),
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const questions = toUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail =
      asString(payload?.command) ?? asString(payload?.reason) ?? asString(payload?.prompt);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    const processPid = toProcessPid(payload);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
          ...(processPid !== undefined ? { processPid } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    const processPid = toProcessPid(payload);
    const configuredEvent =
      availableCommands.length > 0
        ? [
            {
              ...runtimeEventBase(event, canonicalThreadId),
              type: "session.configured" as const,
              payload: {
                config: {
                  availableCommands,
                  capabilities: CODEX_PROVIDER_CAPABILITIES,
                },
              },
            },
          ]
        : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
          ...(processPid !== undefined ? { processPid } : {}),
        },
      },
      ...configuredEvent,
    ];
  }

  if (event.method === "session/started") {
    const processPid = toProcessPid(payload);
    const mergedCommands = mergeSessionConfiguredCommandEntries(
      readSessionConfiguredCommandEntries(payload),
      availableCommands,
    );
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
          ...(processPid !== undefined ? { processPid } : {}),
        },
      },
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.configured",
        payload: {
          config: {
            capabilities: CODEX_PROVIDER_CAPABILITIES,
            ...(mergedCommands ? { availableCommands: mergedCommands } : {}),
          },
        },
      },
    ];
  }

  if (event.method === "session/configured") {
    const mergedCommands = mergeSessionConfiguredCommandEntries(
      readSessionConfiguredCommandEntries(payload),
      availableCommands,
    );
    const configPayload = asObject(payload?.config) ?? payload ?? {};
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.configured",
        payload: {
          config: {
            ...configPayload,
            capabilities: CODEX_PROVIDER_CAPABILITIES,
            ...(mergedCommands ? { availableCommands: mergedCommands } : {}),
          },
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    const processPid = toProcessPid(payload);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
          ...(processPid !== undefined ? { processPid } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/goal/updated") {
    const goal = asObject(payload?.goal);
    const threadId = asString(goal?.threadId) ?? asString(payload?.threadId);
    const objective = asString(goal?.objective);
    if (!threadId || !objective) {
      return [];
    }
    const status = asString(goal?.status);
    return [
      {
        type: "thread.goal.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          goal: {
            threadId,
            objective,
            status:
              status === "paused" ||
              status === "completed" ||
              status === "blocked" ||
              status === "cleared"
                ? status
                : "active",
            ...(asNumber(goal?.tokenBudget) !== undefined
              ? { tokenBudget: asNumber(goal?.tokenBudget) }
              : {}),
            ...(asNumber(goal?.tokensUsed) !== undefined
              ? { tokensUsed: asNumber(goal?.tokensUsed) }
              : {}),
            ...(asNumber(goal?.timeUsedSeconds) !== undefined
              ? { timeUsedSeconds: asNumber(goal?.timeUsedSeconds) }
              : {}),
          },
        },
      },
    ];
  }

  if (event.method === "thread/goal/cleared") {
    const providerThreadId = asString(payload?.threadId);
    return [
      {
        type: "thread.goal.cleared",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: providerThreadId ? { providerThreadId } : {},
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          plan: steps
            .map((entry) => asObject(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
            .map((entry) => ({
              step: asString(entry.step) ?? "step",
              status:
                entry.status === "completed" || entry.status === "inProgress"
                  ? entry.status
                  : "pending",
            })),
        },
      },
    ];
  }

  if (event.method === "hook/started") {
    const run = asObject(payload?.run);
    const hookId = asString(run?.id) ?? String(event.id);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "hook.started",
        payload: {
          hookId,
          hookName: asString(run?.handlerType) ?? "hook",
          hookEvent: asString(run?.eventName) ?? "hook",
        },
      },
    ];
  }

  if (event.method === "hook/completed") {
    const run = asObject(payload?.run);
    const hookId = asString(run?.id) ?? String(event.id);
    const output = hookOutputText(run);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "hook.completed",
        payload: {
          hookId,
          outcome: hookOutcome(run?.status),
          ...(output ? { output } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
        },
      },
    ];
  }

  if (event.method === "rawResponseItem/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (source && isImageGenerationItem(source)) {
      return [imageGenerationAssistantLifecycleEvent(event, canonicalThreadId, "item.completed")];
    }
    return [];
  }

  if (event.method === "item/started") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (source && isImageGenerationItem(source)) {
      return [imageGenerationAssistantLifecycleEvent(event, canonicalThreadId, "item.started")];
    }
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    if (isImageGenerationItem(source)) {
      return [imageGenerationAssistantLifecycleEvent(event, canonicalThreadId, "item.completed")];
    }
    const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(source, payload ?? {});
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(payload ? { data: payload } : {}),
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: willRetry
          ? buildRuntimeWarningPayload(message, event.payload)
          : buildRuntimeErrorPayload({
              message,
              detail: event.payload,
              class: "provider_error",
            }),
      },
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: buildRuntimeErrorPayload({
              message,
              detail: event.payload,
              class: "provider_error",
            }),
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: buildRuntimeWarningPayload(message, event.payload),
          },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: buildRuntimeWarningPayload(
          event.message ?? "Windows world-writable warning",
          event.payload,
        ),
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: buildRuntimeWarningPayload(failureMessage, event.payload),
            },
          ]
        : []),
    ];
  }

  return [];
}

const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  options?: CodexAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const acquireManager = Effect.fn("acquireManager")(function* () {
    if (options?.manager) {
      return options.manager;
    }
    const services = yield* Effect.services<never>();
    return options?.makeManager?.(services) ?? new CodexAppServerManager(services);
  });

  const manager = yield* Effect.acquireRelease(acquireManager(), (manager) =>
    Effect.sync(() => {
      try {
        manager.stopAll();
      } catch {
        // Finalizers should never fail and block shutdown.
      }
    }),
  );
  const serverSettingsService = yield* ServerSettingsService;
  const replayBootstrapByThreadId = new Map<ThreadId, CodexReplayBootstrapState>();
  const extensionCommandsByThreadId = new Map<ThreadId, ReadonlyArray<ProviderSlashCommand>>();

  const startSession: CodexAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const codexSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.map((settings) =>
          resolveProviderSettings(settings, "codex", input.providerInstanceId),
        ),
        Effect.mapError(
          (error) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: error.message,
              cause: error,
            }),
        ),
      );
      const binaryPath = codexSettings.binaryPath;
      const homePath = codexSettings.homePath;
      const discoveredCommands = discoverCodexExtensionSlashCommands({
        cwd: input.cwd,
        codexHome: homePath,
      });
      extensionCommandsByThreadId.set(
        input.threadId,
        mergeProviderSlashCommands(discoveredCommands, [CODEX_GOAL_SLASH_COMMAND]),
      );
      const managerInput: CodexAppServerStartSessionInput = {
        threadId: input.threadId,
        provider: "codex",
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: input.runtimeMode,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        binaryPath,
        ...(homePath ? { homePath } : {}),
        ...(Object.keys(codexSettings.launchEnv).length > 0
          ? { launchEnv: codexSettings.launchEnv }
          : {}),
        ...(input.modelSelection?.provider === "codex"
          ? { model: input.modelSelection.model }
          : {}),
        ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
          ? { serviceTier: "fast" }
          : {}),
      };

      const startManagerSession = (startInput: CodexAppServerStartSessionInput) =>
        Effect.tryPromise({
          try: () => manager.startSession(startInput),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: toMessage(cause, "Failed to start Codex adapter session."),
              cause,
            }),
        });
      let nativeForkSucceeded = false;
      const session = yield* (
        input.forkSource?.resumeCursor !== undefined
          ? startManagerSession({
              ...managerInput,
              forkSource: input.forkSource,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  nativeForkSucceeded = true;
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("codex native fork failed; falling back to transcript replay", {
                  threadId: input.threadId,
                  sourceThreadId: input.forkSource?.threadId,
                  detail: error.message,
                }).pipe(Effect.flatMap(() => startManagerSession(managerInput))),
              ),
            )
          : startManagerSession(managerInput)
      ).pipe(
        Effect.tapError(() =>
          Effect.sync(() => extensionCommandsByThreadId.delete(input.threadId)),
        ),
      );
      const replayTurns = cloneReplayTurns(input.replayTurns);
      replayBootstrapByThreadId.set(input.threadId, {
        replayTurns: nativeForkSucceeded ? [] : replayTurns,
        pendingBootstrapReset: !nativeForkSucceeded && replayTurns.length > 0,
      });
      return {
        ...session,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
      };
    },
  );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* toRequestError(
        input.threadId,
        "turn/start",
        new Error(`Invalid attachment id '${attachment.id}'.`),
      );
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toMessage(cause, "Failed to read attachment file."),
            cause,
          }),
      ),
    );
    return {
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment(input, attachment),
      { concurrency: 1 },
    );
    const replayBootstrap = replayBootstrapByThreadId.get(input.threadId);
    const latestPrompt = input.input ?? "Please analyze the attached files.";
    const promptText =
      replayBootstrap?.pendingBootstrapReset === true
        ? buildBootstrapPromptFromReplayTurns(
            replayBootstrap.replayTurns,
            latestPrompt,
            ROLLBACK_BOOTSTRAP_MAX_CHARS,
          ).text
        : input.input;
    const goalCommand =
      codexAttachments.length === 0 && replayBootstrap?.pendingBootstrapReset !== true
        ? parseCodexGoalCommand(promptText)
        : null;

    if (goalCommand) {
      return yield* Effect.tryPromise({
        try: async () => {
          if (goalCommand.action === "clear") {
            await manager.clearThreadGoal(input.threadId);
          } else if (goalCommand.action === "get") {
            const goal = await manager.getThreadGoal(input.threadId);
            manager.emit("event", {
              id: EventId.makeUnsafe(randomUUID()),
              kind: "notification",
              provider: "codex",
              threadId: input.threadId,
              createdAt: new Date().toISOString(),
              method: goal ? "thread/goal/updated" : "thread/goal/cleared",
              payload: goal ? { threadId: goal.threadId, goal } : {},
            } satisfies ProviderEvent);
          } else {
            if (
              goalCommand.objective !== undefined &&
              goalCommand.objective.length > CODEX_GOAL_MAX_OBJECTIVE_CHARS
            ) {
              throw new Error("Goal objective must be at most 4000 characters.");
            }
            await manager.setThreadGoal({
              threadId: input.threadId,
              ...(goalCommand.objective !== undefined ? { objective: goalCommand.objective } : {}),
              status: goalStatusForCommand(goalCommand.action),
              ...(goalCommand.tokenBudget !== undefined
                ? { tokenBudget: goalCommand.tokenBudget }
                : {}),
            });
          }
          return {
            threadId: input.threadId,
            turnId: TurnId.makeUnsafe(`goal:${Date.now()}`),
          };
        },
        catch: (cause) => toRequestError(input.threadId, "thread/goal", cause),
      });
    }

    return yield* Effect.tryPromise({
      try: () => {
        const managerInput = {
          threadId: input.threadId,
          ...(input.providerThreadId !== undefined
            ? { providerThreadId: input.providerThreadId }
            : {}),
          ...(promptText !== undefined ? { input: promptText } : {}),
          ...(input.modelSelection?.provider === "codex"
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.provider === "codex" &&
          input.modelSelection.options?.reasoningEffort !== undefined
            ? { effort: input.modelSelection.options.reasoningEffort }
            : {}),
          ...(input.modelSelection?.provider === "codex" && input.modelSelection.options?.fastMode
            ? { serviceTier: "fast" }
            : {}),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
        };
        return manager.sendTurn(managerInput).then((result) => {
          if (replayBootstrap?.pendingBootstrapReset) {
            replayBootstrap.pendingBootstrapReset = false;
          }
          return result;
        });
      },
      catch: (cause) => toRequestError(input.threadId, "turn/start", cause),
    }).pipe(
      Effect.map((result) => ({
        ...result,
        threadId: input.threadId,
      })),
    );
  });

  const steerTurn: NonNullable<CodexAdapterShape["steerTurn"]> = Effect.fn("steerTurn")(
    function* (input) {
      const codexAttachments = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) => resolveAttachment(input, attachment),
        { concurrency: 1 },
      );
      return yield* Effect.tryPromise({
        try: () =>
          manager.steerTurn({
            threadId: input.threadId,
            ...(input.input !== undefined ? { input: input.input } : {}),
            ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
          }),
        catch: (cause) => toRequestError(input.threadId, "turn/steer", cause),
      }).pipe(
        Effect.map((result) => ({
          ...result,
          threadId: input.threadId,
        })),
      );
    },
  );

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.tryPromise({
      try: () => manager.interruptTurn(threadId, turnId),
      catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
    });

  const updateGoal: CodexAdapterShape["updateGoal"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (
          input.objective !== undefined &&
          input.objective.length > CODEX_GOAL_MAX_OBJECTIVE_CHARS
        ) {
          throw new Error("Goal objective must be at most 4000 characters.");
        }
        await manager.setThreadGoal({
          threadId: input.threadId,
          ...(input.objective !== undefined ? { objective: input.objective } : {}),
          status: input.status,
          ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
        });
      },
      catch: (cause) => toRequestError(input.threadId, "thread/goal/set", cause),
    });

  const clearGoal: CodexAdapterShape["clearGoal"] = (input) =>
    Effect.tryPromise({
      try: () => manager.clearThreadGoal(input.threadId),
      catch: (cause) => toRequestError(input.threadId, "thread/goal/clear", cause),
    });

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    Effect.tryPromise({
      try: () => manager.readThread(threadId),
      catch: (cause) => toRequestError(threadId, "thread/read", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return Effect.tryPromise({
      try: () => manager.rollbackThread(threadId, numTurns),
      catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
    }).pipe(
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.tryPromise({
      try: () => manager.respondToRequest(threadId, requestId, decision),
      catch: (cause) => toRequestError(threadId, "item/requestApproval/decision", cause),
    });

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.tryPromise({
      try: () => manager.respondToUserInput(threadId, requestId, answers),
      catch: (cause) => toRequestError(threadId, "item/tool/requestUserInput", cause),
    });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.sync(() => {
      replayBootstrapByThreadId.delete(threadId);
      extensionCommandsByThreadId.delete(threadId);
      manager.stopSession(threadId);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.sync(() => manager.listSessions());

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => manager.hasSession(threadId));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.sync(() => {
      replayBootstrapByThreadId.clear();
      extensionCommandsByThreadId.clear();
      manager.stopAll();
    });

  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const registerListener = Effect.fn("registerListener")(function* () {
    const services = yield* Effect.services<never>();
    const listenerEffect = Effect.fn("listener")(function* (event: ProviderEvent) {
      yield* writeNativeEvent(event);
      const runtimeEvents = mapToRuntimeEvents(
        event,
        event.threadId,
        extensionCommandsByThreadId.get(event.threadId),
      );
      if (runtimeEvents.length === 0) {
        yield* Effect.logDebug("ignoring unhandled Codex provider event", {
          method: event.method,
          threadId: event.threadId,
          turnId: event.turnId,
          itemId: event.itemId,
        });
        return;
      }
      yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
    });
    const listener = (event: ProviderEvent) =>
      listenerEffect(event).pipe(Effect.runPromiseWith(services));
    manager.on("event", listener);
    return listener;
  });

  const unregisterListener = Effect.fn("unregisterListener")(function* (
    listener: (event: ProviderEvent) => Promise<void>,
  ) {
    yield* Effect.sync(() => {
      manager.off("event", listener);
    });
    yield* Queue.shutdown(runtimeEventQueue);
  });

  yield* Effect.acquireRelease(registerListener(), unregisterListener);

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      sessionModelOptionsSwitch: "in-session",
      liveTurnDiffMode: "native",
      reviewChangesMode: "provider",
      reviewSurface: "turn-native",
      approvalRequestsMode: "native",
      turnSteeringMode: "native",
      transcriptAuthority: "provider",
      historyAuthority: "provider-session",
      sessionResumeMode: "native",
      ...CODEX_PROVIDER_CAPABILITIES,
    },
    startSession,
    sendTurn,
    steerTurn,
    updateGoal,
    clearGoal,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies CodexAdapterShape;
});

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
