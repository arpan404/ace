import { randomUUID } from "node:crypto";

import {
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionEvent,
} from "@github/copilot-sdk";
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  createGitHubCopilotClient,
  type GitHubCopilotClientLike,
  type GitHubCopilotSessionClient,
  normalizeGitHubCopilotModelOptionsForModel,
} from "../githubCopilotSdk";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  GitHubCopilotAdapter,
  type GitHubCopilotAdapterShape,
} from "../Services/GitHubCopilotAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "githubCopilot" as const;

type UserInputRequest = {
  readonly question: string;
  readonly choices?: ReadonlyArray<string>;
  readonly allowFreeform?: boolean;
};

type UserInputResponse = {
  readonly answer: string;
  readonly wasFreeform: boolean;
};

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly fingerprint?: string;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
  readonly promise: Promise<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly choices: ReadonlyArray<string>;
  readonly allowFreeform: boolean;
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
  readonly promise: Promise<ProviderUserInputAnswers>;
}

interface ToolItemState {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
}

interface TurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  assistantItemId?: string;
  reasoningItemId?: string;
  toolItems: Map<string, ToolItemState>;
  abortRequested: boolean;
}

interface GitHubCopilotSessionContext {
  session: ProviderSession;
  readonly client: GitHubCopilotClientLike;
  readonly sdkSession: GitHubCopilotSessionClient;
  readonly pendingApprovals: Map<string, PendingApproval>;
  readonly pendingUserInputs: Map<string, PendingUserInput>;
  readonly approvalFingerprints: Set<string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly unsubscribers: Array<() => void>;
  turnState: TurnState | undefined;
  stopped: boolean;
}

export interface GitHubCopilotAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function makeDeferredDecision<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function summarizePermissionRequest(request: PermissionRequest): string | undefined {
  if (typeof request.fullCommandText === "string" && request.fullCommandText.trim().length > 0) {
    return request.fullCommandText.trim();
  }
  if (typeof request.fileName === "string" && request.fileName.trim().length > 0) {
    return request.fileName.trim();
  }
  if (typeof request.toolName === "string" && request.toolName.trim().length > 0) {
    return request.toolName.trim();
  }
  if (typeof request.url === "string" && request.url.trim().length > 0) {
    return request.url.trim();
  }
  return undefined;
}

function classifyPermissionRequest(request: PermissionRequest): CanonicalRequestType {
  switch (request.kind) {
    case "shell":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "write":
      return "file_change_approval";
    case "mcp":
    case "custom-tool":
    case "url":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}

function mapApprovalDecision(decision: ProviderApprovalDecision): PermissionRequestResult {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return { kind: "approved" };
    case "decline":
      return { kind: "denied-interactively-by-user" };
    case "cancel":
    default:
      return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
  }
}

function permissionRequestFingerprint(request: PermissionRequest): string | undefined {
  const detail = summarizePermissionRequest(request);
  if (!detail) {
    return undefined;
  }
  return `${request.kind}:${detail}`;
}

function classifyToolItemType(toolName: string | undefined): CanonicalItemType {
  const normalized = toolName?.toLowerCase() ?? "";
  if (normalized.includes("shell") || normalized.includes("command") || normalized === "bash") {
    return "command_execution";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("web") || normalized.includes("search") || normalized.includes("url")) {
    return "web_search";
  }
  if (normalized.includes("image") || normalized.includes("view")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cloneSession(session: ProviderSession): ProviderSession {
  return { ...session };
}

function withoutActiveTurn(session: ProviderSession): ProviderSession {
  const { activeTurnId: _discarded, ...rest } = session;
  return { ...rest };
}

type ProviderRuntimeEventByType<TType extends ProviderRuntimeEvent["type"]> = Extract<
  ProviderRuntimeEvent,
  { type: TType }
>;

function getObjectProperty(value: object, key: string): unknown {
  return key in value ? (value as { readonly [property: string]: unknown })[key] : undefined;
}

function getSessionEventData(event: SessionEvent): object {
  if (!("data" in event)) {
    return {};
  }
  return typeof event.data === "object" && event.data !== null ? event.data : {};
}

function getSessionEventTimestamp(event: SessionEvent): string | undefined {
  return "timestamp" in event && typeof event.timestamp === "string" ? event.timestamp : undefined;
}

function summarizePermissionRequestData(data: object): string | undefined {
  return (
    stringValue(getObjectProperty(data, "fullCommandText")) ??
    stringValue(getObjectProperty(data, "fileName")) ??
    stringValue(getObjectProperty(data, "toolName")) ??
    stringValue(getObjectProperty(data, "url"))
  );
}

function getErrorMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("message" in value)) {
    return undefined;
  }
  return stringValue(value.message);
}

const makeGitHubCopilotAdapter = Effect.fn("makeGitHubCopilotAdapter")(function* (
  options?: GitHubCopilotAdapterLiveOptions,
) {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const sessions = new Map<ThreadId, GitHubCopilotSessionContext>();

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (nativeEventLogger) {
        yield* nativeEventLogger.write(event.raw?.payload ?? event, event.threadId);
      }
      yield* Queue.offer(runtimeEventQueue, event);
    });

  const emitRuntimeEvent = (event: ProviderRuntimeEvent): void => {
    void Effect.runPromise(offerRuntimeEvent(event)).catch(() => undefined);
  };

  const makeBaseEvent = <TType extends ProviderRuntimeEvent["type"]>(
    context: GitHubCopilotSessionContext,
    input: {
      readonly type: TType;
      readonly createdAt?: string | undefined;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly payload: ProviderRuntimeEventByType<TType>["payload"];
      readonly rawMethod: string;
      readonly rawSource: "github-copilot.sdk.event" | "github-copilot.sdk.permission";
      readonly rawPayload: unknown;
      readonly providerItemId?: string | undefined;
    },
  ): ProviderRuntimeEventByType<TType> =>
    ({
      type: input.type,
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: PROVIDER,
      threadId: context.session.threadId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
      ...(input.requestId ? { requestId: RuntimeRequestId.makeUnsafe(input.requestId) } : {}),
      ...(input.providerItemId
        ? { providerRefs: { providerItemId: ProviderItemId.makeUnsafe(input.providerItemId) } }
        : {}),
      payload: input.payload,
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    }) as ProviderRuntimeEventByType<TType>;

  const completeTurn = (
    context: GitHubCopilotSessionContext,
    state: "completed" | "interrupted" | "failed",
    reason?: string,
  ) => {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }
    const completedAt = new Date().toISOString();
    if (state === "interrupted") {
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "turn.aborted",
          createdAt: completedAt,
          turnId: turnState.turnId,
          payload: { reason: reason ?? "Turn interrupted." },
          rawMethod: "turn.aborted",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { state, reason },
        }),
      );
    } else {
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "turn.completed",
          createdAt: completedAt,
          turnId: turnState.turnId,
          payload: {
            state,
            ...(reason ? { errorMessage: reason } : {}),
          },
          rawMethod: "turn.completed",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { state, reason },
        }),
      );
    }
    context.turns.push({ id: turnState.turnId, items: [...turnState.items] });
    context.turnState = undefined;
    context.session = {
      ...withoutActiveTurn(context.session),
      status: "ready",
      updatedAt: completedAt,
      ...(state === "failed" && reason ? { lastError: reason } : {}),
    };
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "session.state.changed",
        createdAt: completedAt,
        payload: {
          state: "ready",
          ...(reason ? { reason } : {}),
        },
        rawMethod: "session.state.changed",
        rawSource: "github-copilot.sdk.event",
        rawPayload: { state: "ready", reason },
      }),
    );
  };

  const ensureContentItem = (
    context: GitHubCopilotSessionContext,
    kind: "assistant" | "reasoning",
  ): string | undefined => {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }
    const existing = kind === "assistant" ? turnState.assistantItemId : turnState.reasoningItemId;
    if (existing) {
      return existing;
    }
    const itemId = randomUUID();
    if (kind === "assistant") {
      turnState.assistantItemId = itemId;
    } else {
      turnState.reasoningItemId = itemId;
    }
    const itemType: CanonicalItemType = kind === "assistant" ? "assistant_message" : "reasoning";
    const event = makeBaseEvent(context, {
      type: "item.started",
      turnId: turnState.turnId,
      itemId,
      payload: {
        itemType,
        title: kind === "assistant" ? "Assistant response" : "Reasoning",
        status: "inProgress",
      },
      rawMethod: `item.started/${kind}`,
      rawSource: "github-copilot.sdk.event",
      rawPayload: { kind },
    });
    turnState.items.push(event);
    emitRuntimeEvent(event);
    return itemId;
  };

  const handleSessionEvent = (context: GitHubCopilotSessionContext, event: SessionEvent): void => {
    const turnState = context.turnState;
    const data = getSessionEventData(event);
    switch (event.type) {
      case "assistant.message_delta": {
        const delta = stringValue(getObjectProperty(data, "deltaContent"));
        const itemId = ensureContentItem(context, "assistant");
        if (!turnState || !itemId || !delta) {
          return;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "content.delta",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          payload: {
            streamKind: "assistant_text",
            delta,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "assistant.reasoning_delta": {
        const delta = stringValue(getObjectProperty(data, "deltaContent"));
        const itemId = ensureContentItem(context, "reasoning");
        if (!turnState || !itemId || !delta) {
          return;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "content.delta",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          payload: {
            streamKind: "reasoning_text",
            delta,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "assistant.message": {
        const content = stringValue(getObjectProperty(data, "content"));
        const itemId = ensureContentItem(context, "assistant");
        if (!turnState || !itemId) {
          return;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.completed",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            ...(content ? { data: { content } } : {}),
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "assistant.reasoning": {
        const content = stringValue(getObjectProperty(data, "content"));
        const itemId = ensureContentItem(context, "reasoning");
        if (!turnState || !itemId) {
          return;
        }
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.completed",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId,
          payload: {
            itemType: "reasoning",
            status: "completed",
            ...(content ? { data: { content } } : {}),
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "tool.execution_start": {
        if (!turnState) {
          return;
        }
        const toolName = stringValue(getObjectProperty(data, "toolName")) ?? "Tool";
        const providerItemId = stringValue(getObjectProperty(data, "toolCallId")) ?? randomUUID();
        const toolItem: ToolItemState = {
          itemId: randomUUID(),
          itemType: classifyToolItemType(toolName),
          toolName,
        };
        turnState.toolItems.set(providerItemId, toolItem);
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.started",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId: toolItem.itemId,
          providerItemId,
          payload: {
            itemType: toolItem.itemType,
            status: "inProgress",
            title: toolName,
            ...(summarizePermissionRequestData(data)
              ? { detail: summarizePermissionRequestData(data) }
              : {}),
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "tool.execution_complete": {
        if (!turnState) {
          return;
        }
        const providerItemId = stringValue(getObjectProperty(data, "toolCallId"));
        const toolItem =
          (providerItemId ? turnState.toolItems.get(providerItemId) : undefined) ??
          ({
            itemId: randomUUID(),
            itemType: classifyToolItemType(stringValue(getObjectProperty(data, "toolName"))),
            toolName: stringValue(getObjectProperty(data, "toolName")) ?? "Tool",
          } satisfies ToolItemState);
        if (providerItemId) {
          turnState.toolItems.delete(providerItemId);
        }
        const success = getObjectProperty(data, "success");
        const error = getObjectProperty(data, "error");
        const runtimeEvent = makeBaseEvent(context, {
          type: "item.completed",
          createdAt: getSessionEventTimestamp(event),
          turnId: turnState.turnId,
          itemId: toolItem.itemId,
          ...(providerItemId ? { providerItemId } : {}),
          payload: {
            itemType: toolItem.itemType,
            status: success === false ? "failed" : "completed",
            title: toolItem.toolName,
            ...(error ? { detail: getErrorMessage(error) } : {}),
            data,
          },
          rawMethod: event.type,
          rawSource: "github-copilot.sdk.event",
          rawPayload: event,
        });
        turnState.items.push(runtimeEvent);
        emitRuntimeEvent(runtimeEvent);
        return;
      }
      case "session.idle": {
        completeTurn(context, turnState?.abortRequested ? "interrupted" : "completed");
        return;
      }
      default:
        return;
    }
  };

  const stopContext = async (context: GitHubCopilotSessionContext): Promise<void> => {
    if (context.stopped) {
      return;
    }
    context.stopped = true;
    for (const pending of context.pendingApprovals.values()) {
      pending.resolve("cancel");
    }
    context.pendingApprovals.clear();
    for (const pending of context.pendingUserInputs.values()) {
      pending.resolve({});
    }
    context.pendingUserInputs.clear();
    for (const unsubscribe of context.unsubscribers) {
      unsubscribe();
    }
    context.unsubscribers.length = 0;
    try {
      await context.sdkSession.disconnect();
    } catch {
      // Preserve shutdown best-effort semantics.
    }
    try {
      await context.client.stop();
    } catch {
      // Preserve shutdown best-effort semantics.
    }
    context.session = {
      ...withoutActiveTurn(context.session),
      status: "closed",
      updatedAt: new Date().toISOString(),
    };
    emitRuntimeEvent(
      makeBaseEvent(context, {
        type: "session.exited",
        payload: {
          exitKind: "graceful",
          reason: "Session stopped.",
        },
        rawMethod: "session.exited",
        rawSource: "github-copilot.sdk.event",
        rawPayload: { reason: "Session stopped." },
      }),
    );
  };

  const startSession: GitHubCopilotAdapterShape["startSession"] = (input) =>
    Effect.tryPromise(async () => {
      if (input.provider !== PROVIDER) {
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      if (input.modelSelection && input.modelSelection.provider !== PROVIDER) {
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected modelSelection.provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
        });
      }

      const settings = await Effect.runPromise(
        serverSettingsService.getSettings.pipe(
          Effect.map((value) => value.providers.githubCopilot),
        ),
      );

      const existing = sessions.get(input.threadId);
      if (existing) {
        await stopContext(existing);
        sessions.delete(input.threadId);
      }

      const client = await createGitHubCopilotClient(settings.binaryPath);

      let context: GitHubCopilotSessionContext | undefined;
      const permissionHandler = async (
        request: PermissionRequest,
      ): Promise<PermissionRequestResult> => {
        if (!context) {
          return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
        }
        if (input.runtimeMode === "full-access") {
          return { kind: "approved" };
        }

        const fingerprint = permissionRequestFingerprint(request);
        if (fingerprint && context.approvalFingerprints.has(fingerprint)) {
          return { kind: "approved" };
        }

        const requestId = randomUUID();
        const deferred = makeDeferredDecision<ProviderApprovalDecision>();
        const detail = summarizePermissionRequest(request);
        context.pendingApprovals.set(requestId, {
          requestType: classifyPermissionRequest(request),
          ...(detail ? { detail } : {}),
          ...(fingerprint ? { fingerprint } : {}),
          resolve: deferred.resolve,
          promise: deferred.promise,
        });

        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "request.opened",
            turnId: context.turnState?.turnId,
            requestId,
            payload: {
              requestType: classifyPermissionRequest(request),
              ...(summarizePermissionRequest(request)
                ? { detail: summarizePermissionRequest(request) }
                : {}),
              args: request,
            },
            rawMethod: "permission.requested",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: request,
          }),
        );

        const decision = await deferred.promise;
        context.pendingApprovals.delete(requestId);
        if (decision === "acceptForSession" && fingerprint) {
          context.approvalFingerprints.add(fingerprint);
        }
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "request.resolved",
            turnId: context.turnState?.turnId,
            requestId,
            payload: {
              requestType: classifyPermissionRequest(request),
              decision,
            },
            rawMethod: "permission.resolved",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: { request, decision },
          }),
        );
        return mapApprovalDecision(decision);
      };

      const userInputHandler = async (request: UserInputRequest): Promise<UserInputResponse> => {
        if (!context) {
          return { answer: "", wasFreeform: true };
        }
        const requestId = randomUUID();
        const deferred = makeDeferredDecision<ProviderUserInputAnswers>();
        const questionId = "response";
        const questions: ReadonlyArray<UserInputQuestion> = [
          {
            id: questionId,
            header: "GitHub Copilot question",
            question: request.question,
            options:
              request.choices?.map((choice: string) => ({ label: choice, description: "" })) ?? [],
            multiSelect: false,
          },
        ];
        context.pendingUserInputs.set(requestId, {
          questions,
          choices: request.choices ?? [],
          allowFreeform: request.allowFreeform ?? true,
          resolve: deferred.resolve,
          promise: deferred.promise,
        });

        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "user-input.requested",
            turnId: context.turnState?.turnId,
            requestId,
            payload: { questions },
            rawMethod: "user-input.requested",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: request,
          }),
        );

        const answers = await deferred.promise;
        context.pendingUserInputs.delete(requestId);
        const selected = answers[questionId] ?? Object.values(answers)[0] ?? "";
        const answer = typeof selected === "string" ? selected : JSON.stringify(selected);
        emitRuntimeEvent(
          makeBaseEvent(context, {
            type: "user-input.resolved",
            turnId: context.turnState?.turnId,
            requestId,
            payload: { answers },
            rawMethod: "user-input.resolved",
            rawSource: "github-copilot.sdk.permission",
            rawPayload: answers,
          }),
        );
        return {
          answer,
          wasFreeform: !(request.choices ?? []).includes(answer),
        };
      };

      try {
        const availableModels = input.modelSelection?.model ? await client.listModels() : [];
        const normalizedModelOptions = normalizeGitHubCopilotModelOptionsForModel(
          availableModels.find((model) => model.id === input.modelSelection?.model),
          input.modelSelection?.options,
        );
        const sdkSession =
          typeof input.resumeCursor === "string"
            ? await client.resumeSession(input.resumeCursor, {
                onPermissionRequest: permissionHandler,
                onUserInputRequest: userInputHandler,
                ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
                ...(normalizedModelOptions?.reasoningEffort
                  ? { reasoningEffort: normalizedModelOptions.reasoningEffort }
                  : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                streaming: true,
              })
            : await client.createSession({
                onPermissionRequest: permissionHandler,
                onUserInputRequest: userInputHandler,
                ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
                ...(normalizedModelOptions?.reasoningEffort
                  ? { reasoningEffort: normalizedModelOptions.reasoningEffort }
                  : {}),
                ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                streaming: true,
              });

        const now = new Date().toISOString();
        const createdContext: GitHubCopilotSessionContext = {
          session: {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
            resumeCursor: sdkSession.sessionId,
            createdAt: now,
            updatedAt: now,
          },
          client,
          sdkSession,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          approvalFingerprints: new Set(),
          turns: [],
          unsubscribers: [],
          turnState: undefined,
          stopped: false,
        };
        context = createdContext;
        createdContext.unsubscribers.push(
          sdkSession.on((event) => {
            handleSessionEvent(createdContext, event);
          }),
        );
        sessions.set(input.threadId, createdContext);

        emitRuntimeEvent(
          makeBaseEvent(createdContext, {
            type: "session.started",
            payload: {
              message:
                typeof input.resumeCursor === "string"
                  ? "Resumed GitHub Copilot session."
                  : "Started GitHub Copilot session.",
              resume: typeof input.resumeCursor === "string" ? input.resumeCursor : undefined,
            },
            rawMethod: "session.started",
            rawSource: "github-copilot.sdk.event",
            rawPayload: {
              sessionId: sdkSession.sessionId,
            },
          }),
        );
        emitRuntimeEvent(
          makeBaseEvent(createdContext, {
            type: "thread.started",
            payload: {
              providerThreadId: sdkSession.sessionId,
            },
            rawMethod: "thread.started",
            rawSource: "github-copilot.sdk.event",
            rawPayload: { sessionId: sdkSession.sessionId },
          }),
        );

        return cloneSession(createdContext.session);
      } catch (cause) {
        try {
          await client.stop();
        } catch {
          // Ignore secondary shutdown failures.
        }
        throw new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: toMessage(cause, "Failed to start GitHub Copilot session."),
          cause,
        });
      }
    });

  const sendTurn: GitHubCopilotAdapterShape["sendTurn"] = (input) =>
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
          issue: `Expected modelSelection.provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
        });
      }
      if (
        input.modelSelection?.model &&
        context.session.model &&
        input.modelSelection.model !== context.session.model
      ) {
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail:
            "GitHub Copilot model changes require a session restart. The orchestration layer should restart this provider session before sending the turn.",
        });
      }

      const turnId = TurnId.makeUnsafe(randomUUID());
      const createdAt = new Date().toISOString();
      context.turnState = {
        turnId,
        startedAt: createdAt,
        items: [],
        toolItems: new Map(),
        abortRequested: false,
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: createdAt,
      };

      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "turn.started",
          createdAt,
          turnId,
          payload: context.session.model ? { model: context.session.model } : {},
          rawMethod: "turn.started",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { input },
        }),
      );
      emitRuntimeEvent(
        makeBaseEvent(context, {
          type: "session.state.changed",
          createdAt,
          payload: {
            state: "running",
          },
          rawMethod: "session.state.changed",
          rawSource: "github-copilot.sdk.event",
          rawPayload: { state: "running" },
        }),
      );

      const attachments = (input.attachments ?? [])
        .map((attachment) => {
          const path = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!path) {
            return null;
          }
          return {
            type: "file" as const,
            path,
            displayName: attachment.name,
          };
        })
        .filter(
          (attachment): attachment is { type: "file"; path: string; displayName: string } =>
            attachment !== null,
        );

      try {
        await context.sdkSession.send({
          prompt: input.input ?? "Please analyze the attached files.",
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      } catch (cause) {
        completeTurn(context, "failed", toMessage(cause, "GitHub Copilot turn failed."));
        throw new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail: toMessage(cause, "GitHub Copilot turn failed."),
          cause,
        });
      }

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.sdkSession.sessionId,
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: GitHubCopilotAdapterShape["interruptTurn"] = (threadId) =>
    Effect.tryPromise(async () => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (context.turnState) {
        context.turnState.abortRequested = true;
      }
      await context.sdkSession.abort();
    });

  const respondToRequest: GitHubCopilotAdapterShape["respondToRequest"] = (
    threadId,
    requestId,
    decision,
  ) =>
    Effect.sync(() => {
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
          method: "respondToRequest",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      pending.resolve(decision);
    });

  const respondToUserInput: GitHubCopilotAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.sync(() => {
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
          method: "respondToUserInput",
          detail: `Unknown pending user input request: ${requestId}`,
        });
      }
      pending.resolve(answers);
    });

  const stopSession: GitHubCopilotAdapterShape["stopSession"] = (threadId) =>
    Effect.tryPromise(async () => {
      const context = sessions.get(threadId);
      if (!context) {
        return;
      }
      sessions.delete(threadId);
      await stopContext(context);
    });

  const listSessions: GitHubCopilotAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => cloneSession(context.session)));

  const hasSession: GitHubCopilotAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => sessions.has(threadId));

  const readThread: GitHubCopilotAdapterShape["readThread"] = (threadId) =>
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

  const rollbackThread: GitHubCopilotAdapterShape["rollbackThread"] = (_threadId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "rollbackThread",
        detail:
          "GitHub Copilot session rollback is not supported by the current adapter implementation.",
      }),
    );

  const stopAll: GitHubCopilotAdapterShape["stopAll"] = () =>
    Effect.tryPromise(async () => {
      await Promise.all(
        Array.from(sessions.entries()).map(async ([threadId, context]) => {
          sessions.delete(threadId);
          await stopContext(context);
        }),
      );
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "restart-session",
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
  } satisfies GitHubCopilotAdapterShape;
});

export const GitHubCopilotAdapterLive = Layer.effect(
  GitHubCopilotAdapter,
  makeGitHubCopilotAdapter(),
);

export function makeGitHubCopilotAdapterLive(options?: GitHubCopilotAdapterLiveOptions) {
  return Layer.effect(GitHubCopilotAdapter, makeGitHubCopilotAdapter(options));
}
