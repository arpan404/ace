import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderReplayTurn,
  ProviderKind,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
  type MessageId,
} from "@ace/contracts";
import { Cache, Cause, Duration, Effect, Equal, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@ace/shared/DrainableWorker";
import { appendTerminalContextsToPrompt } from "@ace/shared/terminalContext";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { meaningfulErrorMessage } from "../../provider/errorCause.ts";
import { ProviderAdapterRequestError, ProviderServiceError } from "../../provider/Errors.ts";
import { resolveProviderIntegrationCapabilities } from "../../provider/providerCapabilities.ts";
import {
  sourceMessagesToHandoffReplayTurns,
  sourceMessagesToReplayTurns,
} from "../../provider/providerReplayTurns.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { resolveTextGenerationModelSelection } from "../../git/textGenerationModelSelection.ts";
import { normalizeUploadChatAttachments } from "../attachmentNormalization.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;
function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const WORKTREE_BRANCH_PREFIX = "ace";
const TEMP_WORKTREE_BRANCH_PATTERN = new RegExp(`^${WORKTREE_BRANCH_PREFIX}\\/[0-9a-f]{8}$`);
const DEFAULT_THREAD_TITLE = "New thread";
const COMPOSER_ISSUE_REFERENCE_MARKER = "\u2063";
const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "Please review the attached image and follow any visible instructions or context.";

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function providerFailureDetailFromCause(cause: Cause.Cause<unknown>): string {
  return meaningfulErrorMessage(Cause.squash(cause), Cause.pretty(cause));
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function activeTurnAlreadyRunningDetail(activeTurnId: TurnId | undefined): string {
  return activeTurnId
    ? `Provider session is already running turn '${activeTurnId}'. Wait for it to finish or interrupt it before starting another turn.`
    : "Provider session is already running a turn. Wait for it to finish or interrupt it before starting another turn.";
}

function isStaleTurnStartReplay(input: {
  readonly latestTurn: { readonly state: "running" | "interrupted" | "completed" | "error" } | null;
  readonly latestTurnRequestedAt: string | null;
  readonly requestedAt: string;
}): boolean {
  if (input.latestTurn === null || input.latestTurnRequestedAt === null) {
    return false;
  }
  if (input.latestTurn.state === "running") {
    return false;
  }
  return input.latestTurnRequestedAt >= input.requestedAt;
}

function isTemporaryWorktreeBranch(branch: string): boolean {
  return TEMP_WORKTREE_BRANCH_PATTERN.test(branch.trim().toLowerCase());
}

function stripIssueReferenceMarkers(text: string): string {
  return text.replaceAll(COMPOSER_ISSUE_REFERENCE_MARKER, "");
}

function resolveThreadProvider(thread: OrchestrationThread): ProviderKind {
  const sessionProvider = thread.session?.providerName;
  if (sessionProvider && Schema.is(ProviderKind)(sessionProvider)) {
    return sessionProvider;
  }
  return thread.modelSelection.provider;
}

function threadCanDispatchQueuedMessage(thread: OrchestrationThread): boolean {
  if (thread.deletedAt !== null || thread.archivedAt !== null) {
    return false;
  }
  if (thread.queuedComposerMessages.length === 0) {
    return false;
  }
  if (thread.latestTurn?.state === "running") {
    return false;
  }
  if (thread.latestTurn?.state === "interrupted" && thread.queuedSteerRequest === null) {
    return false;
  }
  if (thread.session?.status === "running" || (thread.session?.activeTurnId ?? null) !== null) {
    return false;
  }
  return true;
}

function threadMayHaveStaleQueueDispatchBlock(thread: OrchestrationThread): boolean {
  if (thread.queuedComposerMessages.length === 0) {
    return false;
  }
  return (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "running" ||
    (thread.session?.activeTurnId ?? null) !== null
  );
}

function liveProviderSessionBlocksQueueDispatch(session: ProviderSession | undefined): boolean {
  return session?.status === "running" || session?.activeTurnId !== undefined;
}

function isPlanBoundaryToolActivity(activity: OrchestrationThread["activities"][number]): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function isRenderableWorkLogActivity(activity: OrchestrationThread["activities"][number]): boolean {
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

function countRenderableWorkLogActivities(thread: OrchestrationThread): number {
  return thread.activities.filter(isRenderableWorkLogActivity).length;
}

function isQueuedSteerActivityBoundary(
  activity: OrchestrationThread["activities"][number],
): boolean {
  return activity.kind === "tool.completed" || activity.kind === "reasoning.completed";
}

function isQueuedSteerAssistantOutputBoundary(
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
): boolean {
  return event.payload.role === "assistant" && event.payload.streaming === false;
}

function buildQueuedMessageText(message: OrchestrationThread["queuedComposerMessages"][number]) {
  const prompt = stripIssueReferenceMarkers(message.prompt);
  const promptWithTerminalContexts = appendTerminalContextsToPrompt(
    prompt,
    message.terminalContexts,
  );
  return promptWithTerminalContexts.length > 0
    ? promptWithTerminalContexts
    : message.images.length > 0
      ? IMAGE_ONLY_BOOTSTRAP_PROMPT
      : "";
}

function buildQueuedMessageTitleSeed(
  message: OrchestrationThread["queuedComposerMessages"][number],
): string | undefined {
  const prompt = stripIssueReferenceMarkers(message.prompt).trim().replace(/\s+/gu, " ");
  if (prompt.length > 0) {
    return prompt.slice(0, 80);
  }
  const firstImage = message.images[0];
  if (firstImage) {
    return `Image: ${firstImage.name}`;
  }
  const firstTerminalContext = message.terminalContexts[0];
  if (firstTerminalContext) {
    return firstTerminalContext.terminalLabel;
  }
  return undefined;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

function resolveHandoffLineage(input: {
  readonly sourceThreadId: ThreadId;
  readonly threads: ReadonlyArray<OrchestrationThread>;
}): {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly missingThreadId: ThreadId | null;
  readonly hasCycle: boolean;
} {
  const threadsById = new Map(input.threads.map((thread) => [thread.id, thread] as const));
  const lineageNewestFirst: OrchestrationThread[] = [];
  const visited = new Set<string>();
  let currentThreadId: ThreadId | null = input.sourceThreadId;

  while (currentThreadId !== null) {
    const thread = threadsById.get(currentThreadId);
    if (!thread) {
      return {
        threads: lineageNewestFirst.toReversed(),
        missingThreadId: currentThreadId,
        hasCycle: false,
      };
    }
    if (visited.has(thread.id)) {
      return {
        threads: lineageNewestFirst.toReversed(),
        missingThreadId: null,
        hasCycle: true,
      };
    }
    visited.add(thread.id);
    lineageNewestFirst.push(thread);
    currentThreadId = thread.handoff?.sourceThreadId ?? null;
  }

  return {
    threads: lineageNewestFirst.toReversed(),
    missingThreadId: null,
    hasCycle: false,
  };
}

function collectHandoffReplayMessages(
  sourceThreads: ReadonlyArray<OrchestrationThread>,
): ReadonlyArray<{
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
}> {
  const messages: Array<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }> = [];
  for (const thread of sourceThreads) {
    for (const message of thread.messages) {
      messages.push({
        role: message.role,
        text: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      });
    }
  }
  return messages;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const providerCapabilitiesByProvider = new Map<
    ProviderKind,
    OrchestrationSession["capabilities"]
  >();
  const queueDispatchReservationsByThreadId = new Map<
    ThreadId,
    { readonly createdAt: string; readonly messageId: MessageId }
  >();
  const pausedQueueDispatchByThreadId = new Set<ThreadId>();
  const nativeSteerReservationsByThreadId = new Set<ThreadId>();

  const resolveSessionCapabilities = (provider: ProviderKind) => {
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

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendQueueFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
    readonly messageId?: MessageId;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("queue-dispatch-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "thread.queue.dispatch.failed",
        summary: "Queued message dispatch failed",
        payload: {
          detail: input.detail,
          ...(input.messageId ? { messageId: input.messageId } : {}),
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const findLiveSession = (threadId: ThreadId) =>
    providerService
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

  const reconcileThreadSessionFromLiveRuntime = (input: {
    readonly thread: {
      readonly id: ThreadId;
      readonly session: OrchestrationSession | null;
    };
    readonly liveSession: ProviderSession | undefined;
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      const rawProvider = input.liveSession?.provider ?? input.thread.session?.providerName ?? null;
      const provider = rawProvider && Schema.is(ProviderKind)(rawProvider) ? rawProvider : null;
      const capabilities = provider ? yield* resolveSessionCapabilities(provider) : undefined;

      return yield* setThreadSession({
        threadId: input.thread.id,
        session: {
          threadId: input.thread.id,
          status:
            input.liveSession !== undefined
              ? mapProviderSessionStatusToOrchestrationStatus(input.liveSession.status)
              : "stopped",
          providerName: provider,
          ...(capabilities ? { capabilities } : {}),
          runtimeMode:
            input.liveSession?.runtimeMode ??
            input.thread.session?.runtimeMode ??
            DEFAULT_RUNTIME_MODE,
          activeTurnId: null,
          lastError: input.liveSession?.lastError ?? input.thread.session?.lastError ?? null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
    });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const releaseQueueDispatchReservationIfIdle = Effect.fnUntraced(function* (threadId: ThreadId) {
    const reservation = queueDispatchReservationsByThreadId.get(threadId);
    if (!reservation) {
      return;
    }

    const thread = yield* resolveThread(threadId);
    if (!thread || thread.queuedComposerMessages.length === 0) {
      queueDispatchReservationsByThreadId.delete(threadId);
      return;
    }

    if (!threadCanDispatchQueuedMessage(thread)) {
      return;
    }

    if (!thread.latestTurn?.completedAt || thread.latestTurn.completedAt < reservation.createdAt) {
      return;
    }

    const liveSession = yield* findLiveSession(threadId);
    if (liveProviderSessionBlocksQueueDispatch(liveSession)) {
      return;
    }

    queueDispatchReservationsByThreadId.delete(threadId);
  });

  const releaseQueueDispatchReservationForCompletedTurn = Effect.fnUntraced(function* (input: {
    readonly completedAt: string;
    readonly threadId: ThreadId;
  }) {
    const reservation = queueDispatchReservationsByThreadId.get(input.threadId);
    if (!reservation || input.completedAt < reservation.createdAt) {
      return;
    }

    const liveSession = yield* findLiveSession(input.threadId);
    if (liveProviderSessionBlocksQueueDispatch(liveSession)) {
      return;
    }

    queueDispatchReservationsByThreadId.delete(input.threadId);
  });

  const maybeInterruptForQueuedSteer = Effect.fnUntraced(function* (
    threadId: ThreadId,
    input:
      | {
          readonly boundary: "activity";
          readonly activity: OrchestrationThread["activities"][number];
        }
      | {
          readonly boundary: "assistant-output";
          readonly event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
        },
  ) {
    if (
      input.boundary === "activity"
        ? !isQueuedSteerActivityBoundary(input.activity)
        : !isQueuedSteerAssistantOutputBoundary(input.event)
    ) {
      return;
    }

    const thread = yield* resolveThread(threadId);
    const queuedSteerRequest = thread?.queuedSteerRequest ?? null;
    if (!thread || !queuedSteerRequest || queuedSteerRequest.interruptRequested) {
      return;
    }
    if (
      !thread.queuedComposerMessages.some((message) => message.id === queuedSteerRequest.messageId)
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.queue.steer.clear",
        commandId: serverCommandId("queue-steer-clear-stale"),
        threadId,
      });
      return;
    }
    if (thread.latestTurn?.state !== "running") {
      return;
    }
    if (
      input.boundary === "activity" &&
      countRenderableWorkLogActivities(thread) <= queuedSteerRequest.baselineWorkLogEntryCount
    ) {
      return;
    }

    yield* requestQueuedSteerInterrupt(thread, queuedSteerRequest);
  });

  const requestQueuedSteerInterrupt = Effect.fnUntraced(function* (
    thread: OrchestrationThread,
    queuedSteerRequest: NonNullable<OrchestrationThread["queuedSteerRequest"]>,
  ) {
    const activeTurn = thread.latestTurn;
    if (!activeTurn || activeTurn.state !== "running") {
      return;
    }
    const createdAt = new Date().toISOString();
    yield* orchestrationEngine.dispatch({
      type: "thread.queue.steer",
      commandId: serverCommandId("queue-steer-interrupt-requested"),
      threadId: thread.id,
      messageId: queuedSteerRequest.messageId,
      baselineWorkLogEntryCount: queuedSteerRequest.baselineWorkLogEntryCount,
      interruptRequested: true,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.interrupt",
      commandId: serverCommandId("queue-steer-interrupt"),
      threadId: thread.id,
      turnId: activeTurn.turnId,
      createdAt,
    });
  });

  const maybeInterruptOpenCodeQueuedSteerImmediately = Effect.fnUntraced(function* (
    thread: OrchestrationThread,
  ) {
    const queuedSteerRequest = thread.queuedSteerRequest;
    if (
      thread.latestTurn?.state !== "running" ||
      !queuedSteerRequest ||
      queuedSteerRequest.interruptRequested
    ) {
      return false;
    }
    if (resolveThreadProvider(thread) !== "opencode") {
      return false;
    }
    if (
      !thread.queuedComposerMessages.some((message) => message.id === queuedSteerRequest.messageId)
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.queue.steer.clear",
        commandId: serverCommandId("queue-steer-clear-stale"),
        threadId: thread.id,
      });
      return true;
    }
    yield* requestQueuedSteerInterrupt(thread, queuedSteerRequest);
    return true;
  });

  const maybeDispatchNativeQueuedSteer = Effect.fnUntraced(function* (thread: OrchestrationThread) {
    if (thread.latestTurn?.state !== "running" || thread.queuedSteerRequest === null) {
      return false;
    }

    const provider = resolveThreadProvider(thread);
    const capabilities = yield* resolveSessionCapabilities(provider).pipe(
      Effect.catch(() => Effect.succeed<OrchestrationSession["capabilities"] | null>(null)),
    );
    if (!capabilities || capabilities.turnSteeringMode !== "native") {
      return false;
    }

    if (nativeSteerReservationsByThreadId.has(thread.id)) {
      return true;
    }

    const queuedSteerRequest = thread.queuedSteerRequest;
    const steerMessage = thread.queuedComposerMessages.find(
      (message) => message.id === queuedSteerRequest.messageId,
    );
    if (!steerMessage) {
      yield* orchestrationEngine.dispatch({
        type: "thread.queue.steer.clear",
        commandId: serverCommandId("queue-steer-clear-stale"),
        threadId: thread.id,
      });
      return true;
    }

    const createdAt = new Date().toISOString();
    const messageText = buildQueuedMessageText(steerMessage);
    if (messageText.length === 0 && steerMessage.images.length === 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.queue.delete",
        commandId: serverCommandId("queue-drop-empty-native-steer"),
        threadId: thread.id,
        messageId: steerMessage.id,
      });
      return true;
    }

    const attachments = yield* normalizeUploadChatAttachments({
      threadId: thread.id,
      attachments: steerMessage.images.map((image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.dataUrl,
      })),
    }).pipe(
      Effect.catch((error) =>
        appendQueueFailureActivity({
          threadId: thread.id,
          messageId: steerMessage.id,
          detail: error instanceof Error ? error.message : "Failed to prepare queued attachments.",
          createdAt,
        }).pipe(Effect.as([] as ChatAttachment[])),
      ),
    );
    if (attachments.length !== steerMessage.images.length) {
      return true;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.user.append",
      commandId: serverCommandId("queue-native-steer-message-pending"),
      threadId: thread.id,
      messageId: steerMessage.id,
      text: messageText,
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt,
    });

    nativeSteerReservationsByThreadId.add(thread.id);
    const steerResult = yield* providerService
      .steerTurn({
        threadId: thread.id,
        ...(messageText.length > 0 ? { input: messageText } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      .pipe(
        Effect.map((result) => result),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed native queued steering", {
            threadId: thread.id,
            provider,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            nativeSteerReservationsByThreadId.delete(thread.id);
          }),
        ),
      );

    if (!steerResult) {
      return false;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.user.append",
      commandId: serverCommandId("queue-native-steer-message"),
      threadId: thread.id,
      messageId: steerMessage.id,
      text: messageText,
      ...(attachments.length > 0 ? { attachments } : {}),
      turnId: steerResult.turnId,
      createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.queue.delete",
      commandId: serverCommandId("queue-pop-native-steer"),
      threadId: thread.id,
      messageId: steerMessage.id,
    });
    return true;
  });

  const dispatchNextQueuedComposerMessage = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (pausedQueueDispatchByThreadId.has(threadId)) {
      return;
    }
    if (queueDispatchReservationsByThreadId.has(threadId)) {
      return;
    }

    let thread = yield* resolveThread(threadId);
    if (
      thread &&
      !threadCanDispatchQueuedMessage(thread) &&
      threadMayHaveStaleQueueDispatchBlock(thread)
    ) {
      const liveSession = yield* findLiveSession(threadId);
      if (!liveProviderSessionBlocksQueueDispatch(liveSession)) {
        const createdAt = new Date().toISOString();
        yield* reconcileThreadSessionFromLiveRuntime({
          thread,
          liveSession,
          createdAt,
        });
        thread = yield* resolveThread(threadId);
      }
    }

    if (thread && (yield* maybeDispatchNativeQueuedSteer(thread))) {
      return;
    }
    if (thread && (yield* maybeInterruptOpenCodeQueuedSteerImmediately(thread))) {
      return;
    }

    if (!thread || !threadCanDispatchQueuedMessage(thread)) {
      return;
    }

    const liveSession = yield* findLiveSession(threadId);
    if (liveProviderSessionBlocksQueueDispatch(liveSession)) {
      yield* reconcileThreadSessionFromLiveRuntime({
        thread,
        liveSession,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const nextQueuedMessage = thread.queuedComposerMessages[0];
    if (!nextQueuedMessage) {
      return;
    }

    const createdAt = new Date().toISOString();
    const messageText = buildQueuedMessageText(nextQueuedMessage);
    if (messageText.length === 0 && nextQueuedMessage.images.length === 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.queue.delete",
        commandId: serverCommandId("queue-drop-empty"),
        threadId,
        messageId: nextQueuedMessage.id,
      });
      return;
    }

    const attachments = yield* normalizeUploadChatAttachments({
      threadId,
      attachments: nextQueuedMessage.images.map((image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.dataUrl,
      })),
    }).pipe(
      Effect.catch((error) =>
        appendQueueFailureActivity({
          threadId,
          messageId: nextQueuedMessage.id,
          detail: error instanceof Error ? error.message : "Failed to prepare queued attachments.",
          createdAt,
        }).pipe(Effect.as([] as ChatAttachment[])),
      ),
    );
    if (attachments.length !== nextQueuedMessage.images.length) {
      return;
    }

    const previousSteerRequest = thread.queuedSteerRequest;

    yield* orchestrationEngine.dispatch({
      type: "thread.queue.delete",
      commandId: serverCommandId("queue-pop"),
      threadId,
      messageId: nextQueuedMessage.id,
    });

    const titleSeed = buildQueuedMessageTitleSeed(nextQueuedMessage);
    queueDispatchReservationsByThreadId.set(threadId, {
      createdAt,
      messageId: nextQueuedMessage.id,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("queue-turn-start"),
        threadId,
        message: {
          messageId: nextQueuedMessage.id,
          role: "user",
          text: messageText,
          attachments,
        },
        modelSelection: nextQueuedMessage.modelSelection,
        ...(titleSeed !== undefined ? { titleSeed } : {}),
        runtimeMode: nextQueuedMessage.runtimeMode,
        interactionMode: nextQueuedMessage.interactionMode,
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          orchestrationEngine
            .dispatch({
              type: "thread.queue.append",
              commandId: serverCommandId("queue-restore"),
              threadId,
              message: nextQueuedMessage,
              position: "front",
              ...(previousSteerRequest?.messageId === nextQueuedMessage.id
                ? { steerRequest: previousSteerRequest }
                : {}),
            })
            .pipe(
              Effect.flatMap(() =>
                appendQueueFailureActivity({
                  threadId,
                  messageId: nextQueuedMessage.id,
                  detail:
                    error instanceof Error ? error.message : "Failed to start queued message turn.",
                  createdAt,
                }),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  queueDispatchReservationsByThreadId.delete(threadId);
                }),
              ),
              Effect.asVoid,
            ),
        ),
      );
  });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly preferFreshSession?: boolean;
      readonly replayTurns?: ReadonlyArray<ProviderReplayTurn>;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const threadTitle = toNonEmptyProviderInput(thread.title);

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
      readonly replayTurns?: ReadonlyArray<ProviderReplayTurn>;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(threadTitle ? { threadTitle } : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(input?.replayTurns !== undefined ? { replayTurns: input.replayTurns } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const activeSession = yield* resolveActiveSession(existingSessionThreadId);
      const providerCapabilities =
        currentProvider === undefined
          ? {
              sessionModelSwitch: "in-session" as const,
              sessionModelOptionsSwitch: "in-session" as const,
            }
          : yield* providerService.getCapabilities(currentProvider);
      const sessionModelSwitch = providerCapabilities.sessionModelSwitch;
      const sessionModelOptionsSwitch = providerCapabilities.sessionModelOptionsSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadModelSelections.get(threadId) ?? thread.modelSelection;
      const modelOptionsChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider === previousModelSelection.provider &&
        requestedModelSelection.model === previousModelSelection.model &&
        !Equal.equals(previousModelSelection.options, requestedModelSelection.options);
      const shouldRestartForModelSelectionChange =
        modelOptionsChanged && sessionModelOptionsSwitch === "restart-session";
      const shouldRestartReadySessionForTurn =
        options?.preferFreshSession === true &&
        sessionModelSwitch === "restart-session" &&
        thread.session?.activeTurnId === null;
      const shouldRestartMissingLiveSession =
        options?.preferFreshSession === true && activeSession === undefined;

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange &&
        !shouldRestartReadySessionForTurn &&
        !shouldRestartMissingLiveSession
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange || shouldRestartMissingLiveSession
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        shouldRestartReadySessionForTurn,
        shouldRestartMissingLiveSession,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession({
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        ...(shouldRestartMissingLiveSession && options?.replayTurns !== undefined
          ? { replayTurns: options.replayTurns }
          : {}),
      });
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(
      options?.replayTurns !== undefined ? { replayTurns: options.replayTurns } : undefined,
    );
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const sendTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly replayTurns?: ReadonlyArray<ProviderReplayTurn>;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.replayTurns !== undefined ? { replayTurns: input.replayTurns } : {}),
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    if (activeSession?.status === "running") {
      return yield* new ProviderAdapterRequestError({
        provider: activeSession.provider,
        method: "thread.turn.start",
        detail: activeTurnAlreadyRunningDetail(activeSession.activeTurnId),
      });
    }
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const serverSettings = yield* serverSettingsService.getSettings;
      const modelSelection = resolveTextGenerationModelSelection({
        serverSettings,
        fallbackModelSelection: input.modelSelection,
      });

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* git.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection: ModelSelection;
    readonly titleSeed?: string;
  }) {
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const serverSettings = yield* serverSettingsService.getSettings;
      const generated = yield* textGeneration.generateThreadTitle({
        cwd: input.cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        // Thread titles should always use the dedicated text-generation setting.
        modelSelection: resolveTextGenerationModelSelection({
          serverSettings,
        }),
      });
      if (!generated) return;

      const thread = yield* resolveThread(input.threadId);
      if (!thread) return;
      if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("thread-title-rename"),
        threadId: input.threadId,
        title: generated.title,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename thread title", {
          threadId: input.threadId,
          cwd: input.cwd,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    if (
      isStaleTurnStartReplay({
        latestTurn: thread.latestTurn,
        latestTurnRequestedAt: thread.latestTurn?.requestedAt ?? null,
        requestedAt: event.payload.createdAt,
      })
    ) {
      yield* Effect.logDebug("provider command reactor ignored stale turn-start replay", {
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        requestedAt: event.payload.createdAt,
        latestTurnRequestedAt: thread.latestTurn?.requestedAt ?? null,
        latestTurnState: thread.latestTurn?.state ?? null,
      });
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: (yield* orchestrationEngine.getReadModel()).projects,
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        modelSelection: event.payload.modelSelection ?? thread.modelSelection,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          modelSelection: event.payload.modelSelection ?? thread.modelSelection,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const messageIndex = thread.messages.findIndex((entry) => entry.id === message.id);
    const threadReplayTurns = sourceMessagesToReplayTurns(
      thread.messages.slice(0, Math.max(0, messageIndex)),
    );
    let replayTurns: ReadonlyArray<ProviderReplayTurn> = threadReplayTurns;
    if (thread.handoff) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const lineage = resolveHandoffLineage({
        sourceThreadId: thread.handoff.sourceThreadId,
        threads: readModel.threads,
      });
      if (lineage.hasCycle) {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: "Detected a cycle in handoff lineage. The handoff chain cannot be replayed.",
          turnId: null,
          createdAt: event.payload.createdAt,
        });
        return;
      }
      if (lineage.missingThreadId !== null) {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `Handoff source thread '${lineage.missingThreadId}' is unavailable, so handoff context could not be replayed.`,
          turnId: null,
          createdAt: event.payload.createdAt,
        });
        return;
      }
      const handoffReplayMessages = collectHandoffReplayMessages(lineage.threads);
      const handoffReplayTurns = sourceMessagesToHandoffReplayTurns(
        handoffReplayMessages,
        thread.handoff.mode,
      );
      replayTurns = [...handoffReplayTurns, ...threadReplayTurns];
    }

    yield* sendTurnForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      replayTurns,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.catchCause((cause) =>
        appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: providerFailureDetailFromCause(cause),
          turnId: null,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              queueDispatchReservationsByThreadId.delete(event.payload.threadId);
            }),
          ),
        ),
      ),
    );
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const liveSession = yield* findLiveSession(event.payload.threadId).pipe(
            Effect.catchCause(() => Effect.failCause(cause)),
          );

          if (thread.session?.status !== "running") {
            return yield* Effect.failCause(cause);
          }

          if (liveSession?.status === "running") {
            return yield* Effect.failCause(cause);
          }

          yield* reconcileThreadSessionFromLiveRuntime({
            thread,
            liveSession,
            createdAt: event.payload.createdAt,
          });
        }),
      ),
    );
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToUserInput({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        answers: event.payload.answers,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            detail: isUnknownPendingUserInputRequestError(cause)
              ? stalePendingRequestDetail("user-input", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processSessionStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const liveSession = yield* findLiveSession(thread.id).pipe(
              Effect.catchCause(() => Effect.failCause(cause)),
            );
            if (liveSession !== undefined) {
              return yield* Effect.failCause(cause);
            }

            yield* reconcileThreadSessionFromLiveRuntime({
              thread,
              liveSession,
              createdAt: now,
            });
          }),
        ),
      );
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);
  const queueWorker = yield* makeDrainableWorker((threadId: ThreadId) =>
    dispatchNextQueuedComposerMessage(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to dispatch queued message", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    ),
  );

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        if (event.type === "thread.turn-start-requested") {
          pausedQueueDispatchByThreadId.delete(event.payload.threadId);
        } else if (event.type === "thread.turn-interrupt-requested") {
          const thread = yield* resolveThread(event.payload.threadId);
          const isQueuedSteerInterrupt = thread?.queuedSteerRequest?.interruptRequested === true;
          if (!isQueuedSteerInterrupt) {
            pausedQueueDispatchByThreadId.add(event.payload.threadId);
          }
        } else if (event.type === "thread.session-stop-requested") {
          pausedQueueDispatchByThreadId.add(event.payload.threadId);
        }
        return yield* worker.enqueue(event);
      }
      if (event.type === "thread.message-sent") {
        yield* maybeInterruptForQueuedSteer(event.payload.threadId, {
          boundary: "assistant-output",
          event,
        });
        return;
      }
      if (
        event.type === "thread.meta-updated" ||
        event.type === "thread.session-set" ||
        event.type === "thread.turn-diff-completed" ||
        event.type === "thread.activity-appended"
      ) {
        if (event.type === "thread.turn-diff-completed") {
          yield* releaseQueueDispatchReservationForCompletedTurn({
            threadId: event.payload.threadId,
            completedAt: event.payload.completedAt,
          });
        } else if (event.type === "thread.session-set") {
          yield* releaseQueueDispatchReservationIfIdle(event.payload.threadId);
        } else if (
          event.type === "thread.activity-appended" &&
          (event.payload.activity.kind === "provider.turn.start.failed" ||
            event.payload.activity.kind === "thread.queue.dispatch.failed")
        ) {
          queueDispatchReservationsByThreadId.delete(event.payload.threadId);
        }
        if (event.type === "thread.activity-appended") {
          yield* maybeInterruptForQueuedSteer(event.payload.threadId, {
            boundary: "activity",
            activity: event.payload.activity,
          });
        }
        return yield* queueWorker.enqueue(event.payload.threadId);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );

    const readModel = yield* orchestrationEngine.getReadModel();
    for (const thread of readModel.threads) {
      if (thread.queuedComposerMessages.length > 0) {
        yield* queueWorker.enqueue(thread.id);
      }
    }
  });

  return {
    start,
    drain: queueWorker.drain.pipe(Effect.flatMap(() => worker.drain)),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
