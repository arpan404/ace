import { randomUUID } from "node:crypto";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type RuntimeContentStreamKind,
  type RuntimeItemStatus,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Schema, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { startCursorAcpClient, type CursorAcpClient, type CursorAcpJsonRpcId } from "../cursorAcp";
import { type CursorAdapterShape, CursorAdapter } from "../Services/CursorAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveCursorCliModelId } from "./CursorProvider.ts";

const PROVIDER = "cursor" as const;
const ACP_CONTROL_TIMEOUT_MS = 15_000;

type CursorResumeCursor = {
  readonly sessionId: string;
};

type PendingApproval = {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: CursorAcpJsonRpcId;
  readonly turnId?: TurnId;
};

type PendingUserInput =
  | {
      readonly requestId: ApprovalRequestId;
      readonly jsonRpcId: CursorAcpJsonRpcId;
      readonly turnId?: TurnId;
      readonly kind: "ask-question";
      readonly optionIdsByQuestionAndLabel: ReadonlyMap<string, ReadonlyMap<string, string>>;
      readonly questions: ReadonlyArray<UserInputQuestion>;
    }
  | {
      readonly requestId: ApprovalRequestId;
      readonly jsonRpcId: CursorAcpJsonRpcId;
      readonly turnId?: TurnId;
      readonly kind: "create-plan";
      readonly questions: ReadonlyArray<UserInputQuestion>;
    };

type CursorContentItemState = {
  readonly itemId: RuntimeItemId;
  text: string;
};

type TurnSnapshot = {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  assistantText: string;
  reasoningText: string;
  assistantItem: CursorContentItemState | undefined;
  reasoningItem: CursorContentItemState | undefined;
  readonly toolCalls: Map<string, CursorToolState>;
};

type CursorSessionContext = {
  session: ProviderSession;
  readonly client: CursorAcpClient;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<TurnSnapshot>;
  activeTurn: TurnSnapshot | undefined;
  stopping: boolean;
};

type CursorToolState = {
  readonly toolCallId: string;
  readonly itemId: RuntimeItemId;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly status: RuntimeItemStatus;
  readonly detail?: string;
  readonly data: Record<string, unknown>;
};

function isoNow(): string {
  return new Date().toISOString();
}

function readResumeSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sessionId = (value as { readonly sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId.trim()
    : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStreamText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function extractCursorStreamText(
  update: Record<string, unknown> | undefined,
): string | undefined {
  const content = asObject(update?.content);
  return asStreamText(content?.text) ?? asStreamText(update?.text);
}

function contentItemType(kind: "assistant" | "reasoning"): CanonicalItemType {
  return kind === "assistant" ? "assistant_message" : "reasoning";
}

function contentItemTitle(kind: "assistant" | "reasoning") {
  return kind === "assistant" ? "Assistant response" : "Reasoning";
}

function getContentItemState(
  turn: TurnSnapshot,
  kind: "assistant" | "reasoning",
): CursorContentItemState | undefined {
  return kind === "assistant" ? turn.assistantItem : turn.reasoningItem;
}

function setContentItemState(
  turn: TurnSnapshot,
  kind: "assistant" | "reasoning",
  state: CursorContentItemState | undefined,
) {
  if (kind === "assistant") {
    turn.assistantItem = state;
    return;
  }
  turn.reasoningItem = state;
}

function cursorToolLookupInput(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly subagentType?: string | undefined;
}) {
  return {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.subagentType ? { subagentType: input.subagentType } : {}),
  };
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function requestIdFromApprovalRequest(requestId: ApprovalRequestId) {
  return RuntimeRequestId.makeUnsafe(requestId);
}

function toDecisionOptionId(
  decision: ProviderApprovalDecision,
): "allow-once" | "allow-always" | "reject-once" {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    case "cancel":
    default:
      return "reject-once";
  }
}

function stripWrappingBackticks(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("`") && trimmed.endsWith("`") ? trimmed.slice(1, -1).trim() : trimmed;
}

function looksLikeShellCommand(value: string): boolean {
  const normalized = stripWrappingBackticks(value);
  return (
    normalized.includes(" ") ||
    normalized.includes("/") ||
    normalized.includes("&&") ||
    normalized.includes("||") ||
    normalized.includes("|") ||
    normalized.includes("$") ||
    normalized.includes("=")
  );
}

function defaultCursorToolTitle(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Terminal";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image";
    case "collab_agent_tool_call":
      return "Subagent task";
    default:
      return "Tool call";
  }
}

export function classifyCursorToolItemType(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly subagentType?: string | undefined;
}): CanonicalItemType {
  const normalized = [input.kind, input.title, input.subagentType]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  if (
    normalized.includes("subagent") ||
    normalized.includes("sub-agent") ||
    normalized.includes("agent") ||
    normalized.includes("explore") ||
    normalized.includes("browser_use") ||
    normalized.includes("browser use") ||
    normalized.includes("computer_use") ||
    normalized.includes("computer use") ||
    normalized.includes("video_review") ||
    normalized.includes("video review") ||
    normalized.includes("vm_setup_helper") ||
    normalized.includes("vm setup helper")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("execute") ||
    normalized.includes("terminal") ||
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("search") ||
    normalized.includes("url") ||
    normalized.includes("browser")
  ) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyCursorTool(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
}): boolean {
  const normalized = [input.kind, input.title]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  return (
    normalized.includes("read") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function requestTypeForCursorTool(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
}): CanonicalRequestType {
  if (isReadOnlyCursorTool(input)) {
    return "file_read_approval";
  }
  const itemType = classifyCursorToolItemType(input);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function runtimeItemStatusFromCursorStatus(status: string | undefined): RuntimeItemStatus {
  switch (status?.toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "rejected":
    case "declined":
      return "declined";
    default:
      return "inProgress";
  }
}

function isFinalCursorToolStatus(status: RuntimeItemStatus): boolean {
  return status !== "inProgress";
}

function cursorTaskSubagentType(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) {
    return direct;
  }
  const record = asObject(value);
  return asString(record?.custom);
}

function extractCursorToolContentText(
  record: Record<string, unknown> | undefined,
): string | undefined {
  const content = asArray(record?.content);
  if (!content) {
    return undefined;
  }
  for (const entry of content) {
    const contentRecord = asObject(entry);
    const nested = asObject(contentRecord?.content);
    const text = asString(nested?.text) ?? asString(contentRecord?.text);
    if (text) {
      return stripWrappingBackticks(text);
    }
  }
  return undefined;
}

function extractCursorToolCommand(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  for (const candidate of [
    asString(record.command),
    asString(rawInput?.command),
    asString(rawInput?.cmd),
    asString(rawOutput?.command),
  ]) {
    if (candidate) {
      return stripWrappingBackticks(candidate);
    }
  }
  const title = asString(record.title);
  const kind = asString(record.kind);
  if (title && ((kind && kind.toLowerCase().includes("execute")) || looksLikeShellCommand(title))) {
    return stripWrappingBackticks(title);
  }
  return undefined;
}

function extractCursorToolPath(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  for (const candidate of [
    asString(record.filePath),
    asString(record.path),
    asString(record.relativePath),
    asString(rawInput?.filePath),
    asString(rawInput?.path),
    asString(rawOutput?.filePath),
    asString(rawOutput?.path),
  ]) {
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function resolveCursorToolTitle(
  itemType: CanonicalItemType,
  rawTitle: string | undefined,
  previousTitle?: string,
): string {
  const titleCandidate = rawTitle ? stripWrappingBackticks(rawTitle) : undefined;
  if (titleCandidate && !looksLikeShellCommand(titleCandidate)) {
    return titleCandidate;
  }
  return previousTitle ?? defaultCursorToolTitle(itemType);
}

function buildCursorToolData(
  existingData: Record<string, unknown> | undefined,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const rawInput = asObject(record.rawInput) ?? asObject(record.input);
  const rawOutput = asObject(record.rawOutput) ?? asObject(record.output);
  const command = extractCursorToolCommand(record);
  const path = extractCursorToolPath(record);
  const previousItem = asObject(existingData?.item);
  return {
    ...existingData,
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(rawInput ? { input: rawInput } : {}),
    ...(rawOutput ? { result: rawOutput } : {}),
    item: {
      ...previousItem,
      ...(asString(record.title)
        ? { title: stripWrappingBackticks(asString(record.title) ?? "") }
        : {}),
      ...(asString(record.kind) ? { kind: asString(record.kind) } : {}),
      ...(asString(record.status) ? { status: asString(record.status) } : {}),
      ...(asString(record.toolCallId) ? { toolCallId: asString(record.toolCallId) } : {}),
      ...(command ? { command } : {}),
      ...(path ? { path } : {}),
      ...(rawInput ? { input: rawInput } : {}),
      ...(rawOutput ? { result: rawOutput } : {}),
    },
  };
}

export function describePermissionRequest(params: unknown): string | undefined {
  const record = asObject(params);
  if (!record) {
    return undefined;
  }

  const toolCall = asObject(record.toolCall);
  if (toolCall) {
    const itemType = classifyCursorToolItemType(
      cursorToolLookupInput({
        kind: asString(toolCall.kind),
        title: asString(toolCall.title),
      }),
    );
    const detail = extractCursorToolCommand(toolCall) ?? extractCursorToolPath(toolCall);
    if (detail) {
      return detail;
    }
    const toolDetail = extractCursorToolContentText(toolCall);
    if (toolDetail) {
      return toolDetail;
    }
    const title = resolveCursorToolTitle(itemType, asString(toolCall.title));
    if (title.length > 0 && title !== defaultCursorToolTitle(itemType)) {
      return title;
    }
  }

  for (const key of [
    "command",
    "title",
    "message",
    "reason",
    "toolName",
    "tool",
    "filePath",
    "path",
  ] as const) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }

  const request = asObject(record.request);
  if (!request) {
    return undefined;
  }

  for (const key of [
    "command",
    "title",
    "message",
    "reason",
    "toolName",
    "tool",
    "filePath",
    "path",
  ] as const) {
    const value = asString(request[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function streamKindFromUpdateKind(updateKind: string): RuntimeContentStreamKind {
  const normalized = updateKind.toLowerCase();
  if (normalized.includes("summary")) {
    return "reasoning_summary_text";
  }
  if (
    normalized.includes("reason") ||
    normalized.includes("thought") ||
    normalized.includes("thinking")
  ) {
    return "reasoning_text";
  }
  if (normalized.includes("plan")) {
    return "plan_text";
  }
  return "assistant_text";
}

export function permissionOptionIdForRuntimeMode(runtimeMode: ProviderSession["runtimeMode"]): {
  readonly primary: "allow-always" | "allow-once";
  readonly decision: ProviderApprovalDecision;
} {
  if (runtimeMode === "full-access") {
    return {
      primary: "allow-always",
      decision: "acceptForSession",
    };
  }

  return {
    primary: "allow-once",
    decision: "accept",
  };
}

function planStepsFromTodos(
  todos: unknown,
): Array<{ step: string; status: "pending" | "inProgress" | "completed" }> {
  if (!Array.isArray(todos)) {
    return [];
  }
  return todos
    .map((todo) => asObject(todo))
    .filter((todo): todo is Record<string, unknown> => todo !== undefined)
    .map((todo) => ({
      step: asString(todo.content) ?? "Todo",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

export const CursorAdapterLive = Layer.effect(
  CursorAdapter,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const settingsService = yield* ServerSettingsService;
    const services = yield* Effect.services();
    const runPromise = Effect.runPromiseWith(services);
    const eventsPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderRuntimeEvent>(),
      PubSub.shutdown,
    );
    const sessions = new Map<ThreadId, CursorSessionContext>();

    const emit = (event: ProviderRuntimeEvent) => {
      void runPromise(PubSub.publish(eventsPubSub, event).pipe(Effect.asVoid));
    };

    const resolveSelectedModel = (modelSelection: { readonly model: string } | undefined) =>
      modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER.cursor;

    const baseEvent = (
      context: CursorSessionContext,
      input: {
        readonly turnId?: TurnId;
        readonly itemId?: RuntimeItemId;
        readonly requestId?: ApprovalRequestId;
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      } = {},
    ) => ({
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: isoNow(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.requestId ? { requestId: requestIdFromApprovalRequest(input.requestId) } : {}),
      ...(input.rawMethod
        ? {
            raw: {
              source:
                input.rawSource ??
                (input.requestId
                  ? ("cursor.acp.request" as const)
                  : ("cursor.acp.notification" as const)),
              method: input.rawMethod,
              payload: input.rawPayload ?? {},
            },
          }
        : {}),
    });

    const updateSession = (context: CursorSessionContext, patch: Partial<ProviderSession>) => {
      context.session = {
        ...context.session,
        ...patch,
        updatedAt: isoNow(),
      };
    };

    const ensureContentItem = (
      context: CursorSessionContext,
      turnId: TurnId,
      kind: "assistant" | "reasoning",
      input: {
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ): CursorContentItemState | undefined => {
      const activeTurn = context.activeTurn;
      if (!activeTurn || activeTurn.id !== turnId) {
        return undefined;
      }
      const existing = getContentItemState(activeTurn, kind);
      if (existing) {
        return existing;
      }
      const state: CursorContentItemState = {
        itemId: RuntimeItemId.makeUnsafe(`cursor-${kind}:${randomUUID()}`),
        text: "",
      };
      setContentItemState(activeTurn, kind, state);
      emit({
        ...baseEvent(context, {
          turnId,
          itemId: state.itemId,
          rawMethod: input.rawMethod,
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input.rawSource ? { rawSource: input.rawSource } : {}),
        }),
        type: "item.started",
        payload: {
          itemType: contentItemType(kind),
          title: contentItemTitle(kind),
          status: "inProgress",
        },
      });
      return state;
    };

    const completeContentItem = (
      context: CursorSessionContext,
      turnId: TurnId,
      kind: "assistant" | "reasoning",
      input?: {
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      const activeTurn = context.activeTurn;
      if (!activeTurn || activeTurn.id !== turnId) {
        return;
      }
      const state = getContentItemState(activeTurn, kind);
      if (!state) {
        return;
      }
      setContentItemState(activeTurn, kind, undefined);
      emit({
        ...baseEvent(context, {
          turnId,
          itemId: state.itemId,
          ...(input?.rawMethod ? { rawMethod: input.rawMethod } : {}),
          ...(input?.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input?.rawSource ? { rawSource: input.rawSource } : {}),
        }),
        type: "item.completed",
        payload: {
          itemType: contentItemType(kind),
          title: contentItemTitle(kind),
          status: "completed",
          ...(state.text.length > 0 ? { detail: state.text } : {}),
        },
      });
    };

    const completeActiveContentItems = (
      context: CursorSessionContext,
      turnId: TurnId,
      input?: {
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      completeContentItem(context, turnId, "assistant", input);
      completeContentItem(context, turnId, "reasoning", input);
    };

    const emitToolLifecycleEvent = (
      context: CursorSessionContext,
      input: {
        readonly turnId: TurnId;
        readonly tool: CursorToolState;
        readonly type: "item.started" | "item.updated" | "item.completed";
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      emit({
        ...baseEvent(context, {
          turnId: input.turnId,
          itemId: input.tool.itemId,
          rawMethod: input.rawMethod,
          ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
          ...(input.rawSource ? { rawSource: input.rawSource } : {}),
        }),
        type: input.type,
        payload: {
          itemType: input.tool.itemType,
          status: input.tool.status,
          title: input.tool.title,
          ...(input.tool.detail ? { detail: input.tool.detail } : {}),
          ...(Object.keys(input.tool.data).length > 0 ? { data: input.tool.data } : {}),
        },
      });
    };

    const syncCursorToolCall = (
      context: CursorSessionContext,
      turnId: TurnId,
      record: Record<string, unknown>,
      input: {
        readonly rawMethod: string;
        readonly rawPayload?: unknown;
        readonly rawSource?: "cursor.acp.request" | "cursor.acp.notification" | undefined;
      },
    ) => {
      const activeTurn = context.activeTurn;
      if (!activeTurn) {
        return undefined;
      }
      const toolCallId = asString(record.toolCallId);
      if (!toolCallId) {
        return undefined;
      }
      const existing = activeTurn.toolCalls.get(toolCallId);
      const detectedItemType = classifyCursorToolItemType(
        cursorToolLookupInput({
          kind: asString(record.kind),
          title: asString(record.title),
        }),
      );
      const itemType =
        existing && existing.itemType !== "dynamic_tool_call"
          ? existing.itemType
          : detectedItemType;
      const status = asString(record.status)
        ? runtimeItemStatusFromCursorStatus(asString(record.status))
        : (existing?.status ?? "inProgress");
      const title = resolveCursorToolTitle(itemType, asString(record.title), existing?.title);
      const detail =
        extractCursorToolCommand(record) ??
        extractCursorToolPath(record) ??
        extractCursorToolContentText(record) ??
        existing?.detail;
      const tool: CursorToolState = {
        toolCallId,
        itemId: existing?.itemId ?? RuntimeItemId.makeUnsafe(`cursor-tool:${randomUUID()}`),
        itemType,
        title,
        status,
        ...(detail ? { detail } : {}),
        data: buildCursorToolData(existing?.data, record),
      };
      activeTurn.toolCalls.set(toolCallId, tool);
      if (!existing) {
        activeTurn.items.push({
          kind: "tool_call",
          toolCallId,
          itemType,
          data: tool.data,
        });
      }
      emitToolLifecycleEvent(context, {
        turnId,
        tool,
        type:
          !existing && !isFinalCursorToolStatus(status)
            ? "item.started"
            : isFinalCursorToolStatus(status)
              ? "item.completed"
              : "item.updated",
        rawMethod: input.rawMethod,
        ...(input.rawPayload !== undefined ? { rawPayload: input.rawPayload } : {}),
        ...(input.rawSource ? { rawSource: input.rawSource } : {}),
      });
      return tool;
    };

    const settleTurn = (
      context: CursorSessionContext,
      turnId: TurnId,
      outcome:
        | {
            readonly type: "completed";
            readonly stopReason?: string | null;
            readonly errorMessage?: string;
          }
        | { readonly type: "aborted"; readonly reason: string },
    ) => {
      if (!context.activeTurn || context.activeTurn.id !== turnId) {
        return;
      }

      completeActiveContentItems(context, turnId);
      context.turns.push(context.activeTurn);
      context.activeTurn = undefined;
      updateSession(context, {
        activeTurnId: undefined,
        status: outcome.type === "completed" && outcome.errorMessage ? "error" : "ready",
        ...(outcome.type === "completed" && outcome.errorMessage
          ? { lastError: outcome.errorMessage }
          : {}),
      });

      if (outcome.type === "completed") {
        emit({
          ...baseEvent(context, { turnId }),
          type: "turn.completed",
          payload: {
            state: outcome.errorMessage ? "failed" : "completed",
            ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
            ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          },
        });
        return;
      }

      emit({
        ...baseEvent(context, { turnId }),
        type: "turn.aborted",
        payload: {
          reason: outcome.reason,
        },
      });
    };

    const handleSessionUpdate = (context: CursorSessionContext, params: unknown) => {
      const record = asObject(params);
      const update = asObject(record?.update);
      const updateKind = asString(update?.sessionUpdate);
      const turnId = context.activeTurn?.id;

      if (!updateKind || !turnId || !update) {
        return;
      }

      if (updateKind === "tool_call" || updateKind === "tool_call_update") {
        completeActiveContentItems(context, turnId, {
          rawMethod: "session/update",
          rawPayload: params,
        });
        syncCursorToolCall(context, turnId, update, {
          rawMethod: "session/update",
          rawPayload: params,
        });
        return;
      }

      const text = extractCursorStreamText(update);
      if (!text) {
        return;
      }

      if (updateKind.toLowerCase().includes("plan")) {
        completeActiveContentItems(context, turnId, {
          rawMethod: "session/update",
          rawPayload: params,
        });
        emit({
          ...baseEvent(context, { turnId, rawMethod: "session/update", rawPayload: params }),
          type: "turn.proposed.delta",
          payload: { delta: text },
        });
        return;
      }

      const activeTurn = context.activeTurn;
      if (!activeTurn) {
        return;
      }

      const streamKind = streamKindFromUpdateKind(updateKind);
      const itemStateInput = { rawMethod: "session/update", rawPayload: params } as const;
      let itemId: RuntimeItemId | undefined;
      if (streamKind === "assistant_text") {
        completeContentItem(context, turnId, "reasoning", itemStateInput);
        const assistantItem = ensureContentItem(context, turnId, "assistant", itemStateInput);
        if (!assistantItem) {
          return;
        }
        assistantItem.text += text;
        itemId = assistantItem.itemId;
        activeTurn.assistantText += text;
      } else if (streamKind === "reasoning_text" || streamKind === "reasoning_summary_text") {
        completeContentItem(context, turnId, "assistant", itemStateInput);
        const reasoningItem = ensureContentItem(context, turnId, "reasoning", itemStateInput);
        if (!reasoningItem) {
          return;
        }
        reasoningItem.text += text;
        itemId = reasoningItem.itemId;
        activeTurn.reasoningText += text;
      } else {
        completeActiveContentItems(context, turnId, itemStateInput);
      }
      activeTurn.items.push({ kind: streamKind, text, ...(itemId ? { itemId } : {}) });
      emit({
        ...baseEvent(context, {
          turnId,
          ...(itemId ? { itemId } : {}),
          rawMethod: "session/update",
          rawPayload: params,
        }),
        type: "content.delta",
        payload: {
          streamKind,
          delta: text,
        },
      });
    };

    const handleRequest = (
      context: CursorSessionContext,
      request: {
        readonly id: CursorAcpJsonRpcId;
        readonly method: string;
        readonly params?: unknown;
      },
    ) => {
      const turnId = context.activeTurn?.id;

      if (request.method === "session/request_permission") {
        const params = asObject(request.params);
        const toolCall = asObject(params?.toolCall);
        if (toolCall && turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        if (toolCall && turnId) {
          syncCursorToolCall(context, turnId, toolCall, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        const requestType = requestTypeForCursorTool(
          cursorToolLookupInput({
            kind: asString(toolCall?.kind),
            title: asString(toolCall?.title),
          }),
        );
        if (context.session.runtimeMode === "full-access") {
          const resolution = permissionOptionIdForRuntimeMode(context.session.runtimeMode);
          context.client.respond(request.id, {
            outcome: {
              outcome: "selected",
              optionId: resolution.primary,
            },
          });
          return;
        }

        const requestId = ApprovalRequestId.makeUnsafe(`cursor-permission:${randomUUID()}`);
        context.pendingApprovals.set(requestId, {
          requestId,
          jsonRpcId: request.id,
          ...(turnId ? { turnId } : {}),
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            requestId,
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "request.opened",
          payload: {
            requestType,
            ...(describePermissionRequest(request.params)
              ? { detail: describePermissionRequest(request.params) }
              : {}),
            ...(request.params !== undefined ? { args: request.params } : {}),
          },
        });
        return;
      }

      if (request.method === "cursor/ask_question") {
        const params = asObject(request.params);
        if (turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        const questions = Array.isArray(params?.questions) ? params.questions : [];
        const optionIdsByQuestionAndLabel = new Map<string, ReadonlyMap<string, string>>();
        const normalizedQuestions = questions
          .map((entry) => asObject(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
          .map((entry) => {
            const questionId = asString(entry.id) ?? `question-${randomUUID()}`;
            const options = Array.isArray(entry.options) ? entry.options : [];
            const labelMap = new Map<string, string>();
            const normalizedOptions = options
              .map((option) => asObject(option))
              .filter((option): option is Record<string, unknown> => option !== undefined)
              .map((option) => {
                const optionId = asString(option.id) ?? randomUUID();
                const label = asString(option.label) ?? optionId;
                labelMap.set(label, optionId);
                return {
                  label,
                  description: label,
                };
              });
            optionIdsByQuestionAndLabel.set(questionId, labelMap);
            const normalizedQuestion: {
              id: string;
              header: string;
              question: string;
              options: Array<{ label: string; description: string }>;
              multiSelect?: true;
            } = {
              id: questionId,
              header: asString(params?.title) ?? "Need input",
              question: asString(entry.prompt) ?? "Choose an option",
              options: normalizedOptions,
            };
            if (entry.allowMultiple === true) {
              normalizedQuestion.multiSelect = true;
            }
            return normalizedQuestion;
          });
        const requestId = ApprovalRequestId.makeUnsafe(`cursor-question:${randomUUID()}`);
        context.pendingUserInputs.set(requestId, {
          requestId,
          jsonRpcId: request.id,
          ...(turnId ? { turnId } : {}),
          kind: "ask-question",
          optionIdsByQuestionAndLabel,
          questions: normalizedQuestions,
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            requestId,
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "user-input.requested",
          payload: {
            questions: normalizedQuestions,
          },
        });
        return;
      }

      if (request.method === "cursor/create_plan") {
        const params = asObject(request.params);
        if (turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: request.method,
            rawPayload: request.params,
            rawSource: "cursor.acp.request",
          });
        }
        const requestId = ApprovalRequestId.makeUnsafe(`cursor-plan:${randomUUID()}`);
        const questionId = "plan_decision";
        const questions: ReadonlyArray<UserInputQuestion> = [
          {
            id: questionId,
            header: asString(params?.name) ?? "Plan approval",
            question: asString(params?.overview) ?? "Approve the proposed plan?",
            options: [
              { label: "Accept", description: "Approve the proposed plan" },
              { label: "Reject", description: "Reject the proposed plan" },
              { label: "Cancel", description: "Cancel plan approval" },
            ],
          },
        ];
        context.pendingUserInputs.set(requestId, {
          requestId,
          jsonRpcId: request.id,
          ...(turnId ? { turnId } : {}),
          kind: "create-plan",
          questions,
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "turn.plan.updated",
          payload: {
            ...(asString(params?.overview) ? { explanation: asString(params?.overview) } : {}),
            plan: planStepsFromTodos(params?.todos),
          },
        });
        if (asString(params?.plan)) {
          emit({
            ...baseEvent(context, {
              ...(turnId ? { turnId } : {}),
              rawMethod: request.method,
              rawPayload: request.params,
            }),
            type: "turn.proposed.completed",
            payload: {
              planMarkdown: asString(params?.plan) ?? "",
            },
          });
        }
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            requestId,
            rawMethod: request.method,
            rawPayload: request.params,
          }),
          type: "user-input.requested",
          payload: {
            questions,
          },
        });
        return;
      }

      context.client.respondError(
        request.id,
        -32601,
        `Unsupported Cursor ACP request: ${request.method}`,
      );
    };

    const handleNotification = (
      context: CursorSessionContext,
      notification: { readonly method: string; readonly params?: unknown },
    ) => {
      if (notification.method === "session/update") {
        handleSessionUpdate(context, notification.params);
        return;
      }

      if (notification.method === "cursor/update_todos") {
        const params = asObject(notification.params);
        if (context.activeTurn?.id) {
          completeActiveContentItems(context, context.activeTurn.id, {
            rawMethod: notification.method,
            rawPayload: notification.params,
          });
        }
        emit({
          ...baseEvent(context, {
            ...(context.activeTurn?.id ? { turnId: context.activeTurn.id } : {}),
            rawMethod: notification.method,
            rawPayload: notification.params,
          }),
          type: "turn.plan.updated",
          payload: {
            plan: planStepsFromTodos(params?.todos),
          },
        });
        return;
      }

      if (notification.method === "cursor/task") {
        const params = asObject(notification.params);
        const turnId = context.activeTurn?.id;
        if (turnId) {
          completeActiveContentItems(context, turnId, {
            rawMethod: notification.method,
            rawPayload: notification.params,
          });
        }
        const subagentType = cursorTaskSubagentType(params?.subagentType);
        const itemType = classifyCursorToolItemType(
          cursorToolLookupInput({
            title: asString(params?.description),
            subagentType,
          }),
        );
        const prompt = asString(params?.prompt);
        const itemId = RuntimeItemId.makeUnsafe(
          asString(params?.agentId) ?? `cursor-task:${randomUUID()}`,
        );
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            itemId,
            rawMethod: notification.method,
            rawPayload: notification.params,
          }),
          type: "item.completed",
          payload: {
            itemType,
            status: "completed",
            title: asString(params?.description) ?? defaultCursorToolTitle(itemType),
            ...(prompt ? { detail: prompt } : {}),
            data: {
              ...(subagentType ? { subagentType } : {}),
              ...(prompt ? { prompt } : {}),
              ...(asString(params?.model) ? { model: asString(params?.model) } : {}),
              ...(asString(params?.agentId) ? { agentId: asString(params?.agentId) } : {}),
              ...(typeof params?.durationMs === "number" ? { durationMs: params.durationMs } : {}),
            },
          },
        });
        emit({
          ...baseEvent(context, {
            ...(turnId ? { turnId } : {}),
            rawMethod: notification.method,
            rawPayload: notification.params,
          }),
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(
              asString(params?.agentId) ?? `cursor-task:${randomUUID()}`,
            ),
            status: "completed",
            ...(asString(params?.description) ? { summary: asString(params?.description) } : {}),
            ...(params && "durationMs" in params
              ? { usage: { durationMs: params.durationMs } }
              : {}),
          },
        });
      }
    };

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      Effect.tryPromise(async () => {
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected Cursor model selection, received '${input.modelSelection.provider}'.`,
          });
        }

        const settings = await runPromise(settingsService.getSettings);
        const existing = sessions.get(input.threadId);
        if (existing) {
          return existing.session;
        }
        const selectedModel = resolveSelectedModel(input.modelSelection);
        const cursorCliModel = input.modelSelection
          ? resolveCursorCliModelId({
              model: selectedModel,
              options: input.modelSelection.options,
            })
          : selectedModel;

        const client = startCursorAcpClient({
          binaryPath: settings.providers.cursor.binaryPath,
          model: cursorCliModel,
        });
        const createdAt = isoNow();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          model: selectedModel,
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        const context: CursorSessionContext = {
          session,
          client,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          turns: [],
          activeTurn: undefined,
          stopping: false,
        };
        sessions.set(input.threadId, context);

        client.setProtocolErrorHandler((error) => {
          emit({
            ...baseEvent(context),
            type: "runtime.error",
            payload: {
              message: error.message,
              class: "transport_error",
            },
          });
        });
        client.setNotificationHandler((notification) => handleNotification(context, notification));
        client.setRequestHandler((request) => handleRequest(context, request));
        client.setCloseHandler(({ code, signal }) => {
          const activeContext = sessions.get(input.threadId);
          if (!activeContext) {
            return;
          }
          sessions.delete(input.threadId);
          if (activeContext.activeTurn) {
            settleTurn(activeContext, activeContext.activeTurn.id, {
              type: "completed",
              errorMessage: `Cursor ACP exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
            });
          }
          updateSession(activeContext, { status: "closed", activeTurnId: undefined });
          emit({
            ...baseEvent(activeContext),
            type: "session.exited",
            payload: {
              reason: activeContext.stopping
                ? "Cursor session stopped"
                : `Cursor ACP exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
              exitKind: activeContext.stopping ? "graceful" : "error",
            },
          });
        });

        emit({
          ...baseEvent(context),
          type: "session.state.changed",
          payload: {
            state: "starting",
            reason: "Starting Cursor ACP session",
          },
        });

        await client.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: "t3code",
              version: "1.0.17",
            },
          },
          { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
        );
        await client.request(
          "authenticate",
          { methodId: "cursor_login" },
          { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
        );

        const resumeSessionId = readResumeSessionId(input.resumeCursor);
        const sessionResult = (await client.request(
          resumeSessionId ? "session/load" : "session/new",
          resumeSessionId
            ? { sessionId: resumeSessionId }
            : {
                cwd: input.cwd ?? serverConfig.cwd,
                mode: "agent",
                mcpServers: [],
              },
          { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
        )) as { readonly sessionId?: unknown };
        const sessionId =
          asString(sessionResult?.sessionId) ?? resumeSessionId ?? `cursor-session:${randomUUID()}`;

        updateSession(context, {
          status: "ready",
          ...((input.cwd ?? serverConfig.cwd) ? { cwd: input.cwd ?? serverConfig.cwd } : {}),
          model: selectedModel,
          resumeCursor: {
            sessionId,
          } satisfies CursorResumeCursor,
        });

        emit({
          ...baseEvent(context),
          type: "session.started",
          payload: {
            resume: context.session.resumeCursor,
          },
        });
        emit({
          ...baseEvent(context),
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        });
        emit({
          ...baseEvent(context),
          type: "thread.started",
          payload: {
            providerThreadId: sessionId,
          },
        });

        return context.session;
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterValidationError)(cause) ||
          Schema.is(ProviderAdapterProcessError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "startSession",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise(async () => {
        const context = sessions.get(input.threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Expected Cursor model selection, received '${input.modelSelection.provider}'.`,
          });
        }
        if (input.attachments && input.attachments.length > 0) {
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Cursor ACP image attachments are not implemented yet.",
          });
        }
        if (context.activeTurn) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "Cursor session already has an active turn.",
          });
        }
        const sessionId = readResumeSessionId(context.session.resumeCursor);
        if (!sessionId) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "Cursor session is missing a resumable session id.",
          });
        }

        const turnId = TurnId.makeUnsafe(`cursor-turn:${randomUUID()}`);
        const selectedModel = resolveSelectedModel(input.modelSelection);
        const activeTurn: TurnSnapshot = {
          id: turnId,
          items: [],
          assistantText: "",
          reasoningText: "",
          assistantItem: undefined,
          reasoningItem: undefined,
          toolCalls: new Map(),
        };
        context.activeTurn = activeTurn;
        updateSession(context, {
          status: "running",
          activeTurnId: turnId,
          model: selectedModel,
        });
        emit({
          ...baseEvent(context, { turnId }),
          type: "turn.started",
          payload: {
            model: selectedModel,
            ...(input.interactionMode === "plan" ? { effort: "plan" } : {}),
          },
        });

        void context.client
          .request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: input.input ?? "" }],
          })
          .then((result) => {
            const record = asObject(result);
            settleTurn(context, turnId, {
              type: "completed",
              stopReason: asString(record?.stopReason) ?? null,
            });
          })
          .catch((error) => {
            emit({
              ...baseEvent(context, { turnId }),
              type: "runtime.error",
              payload: {
                message: error instanceof Error ? error.message : String(error),
                class: "provider_error",
              },
            });
            settleTurn(context, turnId, {
              type: "completed",
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        } satisfies ProviderTurnStartResult;
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause) ||
          Schema.is(ProviderAdapterValidationError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.tryPromise(async () => {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        if (!context.activeTurn) {
          return;
        }
        if (turnId && context.activeTurn.id !== turnId) {
          return;
        }
        const sessionId = readResumeSessionId(context.session.resumeCursor);
        if (!sessionId) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/cancel",
            detail: "Cursor session is missing a resumable session id.",
          });
        }
        await context.client.request(
          "session/cancel",
          { sessionId },
          { timeoutMs: ACP_CONTROL_TIMEOUT_MS },
        );
        settleTurn(context, context.activeTurn.id, {
          type: "aborted",
          reason: "Turn cancelled",
        });
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/cancel",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise(async () => {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request '${requestId}'.`,
          });
        }
        context.pendingApprovals.delete(requestId);
        context.client.respond(pending.jsonRpcId, {
          outcome: {
            outcome: "selected",
            optionId: toDecisionOptionId(decision),
          },
        });
        emit({
          ...baseEvent(context, {
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId,
          }),
          type: "request.resolved",
          payload: {
            requestType: "command_execution_approval",
            decision,
            resolution: {
              optionId: toDecisionOptionId(decision),
            },
          },
        });
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise(async () => {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          throw new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request '${requestId}'.`,
          });
        }

        context.pendingUserInputs.delete(requestId);

        if (pending.kind === "ask-question") {
          const selectedAnswers = pending.questions.map((question) => {
            const answer = answers[question.id];
            const label = typeof answer === "string" ? answer : "";
            const optionId = pending.optionIdsByQuestionAndLabel.get(question.id)?.get(label);
            return {
              questionId: question.id,
              selectedOptionIds: optionId ? [optionId] : [],
            };
          });
          context.client.respond(pending.jsonRpcId, {
            outcome: {
              outcome: "answered",
              answers: selectedAnswers,
            },
          });
        } else {
          const answer =
            typeof answers.plan_decision === "string" ? answers.plan_decision : "Cancel";
          context.client.respond(pending.jsonRpcId, {
            outcome:
              answer === "Accept"
                ? { outcome: "accepted" }
                : answer === "Reject"
                  ? { outcome: "rejected", reason: "Rejected in T3 Code" }
                  : { outcome: "cancelled" },
          });
        }

        emit({
          ...baseEvent(context, {
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId,
          }),
          type: "user-input.resolved",
          payload: {
            answers,
          },
        });
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause) ||
          Schema.is(ProviderAdapterRequestError)(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToUserInput",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      Effect.tryPromise(async () => {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        context.stopping = true;
        await context.client.close();
        sessions.delete(threadId);
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(ProviderAdapterSessionNotFoundError)(cause)
            ? cause
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => context.session));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (_threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail:
            "Cursor ACP session rollback is not supported by the current adapter implementation.",
        }),
      );

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.promise(() =>
        Promise.all(
          Array.from(sessions.entries()).map(async ([threadId, context]) => {
            context.stopping = true;
            sessions.delete(threadId);
            await context.client.close();
          }),
        ).then(() => undefined),
      );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "restart-session" },
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
      get streamEvents() {
        return Stream.fromPubSub(eventsPubSub);
      },
    } satisfies CursorAdapterShape;
  }),
);
