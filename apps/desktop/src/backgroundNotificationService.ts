import * as Crypto from "node:crypto";

import {
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type DesktopNotificationInput,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ServerConfigStreamEvent,
  type ServerSettings,
} from "@ace/contracts";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsRpcProtocolClient,
} from "@ace/shared/wsRpcProtocol";
import { Duration, Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";

const APPROVAL_COPY_BY_KIND: Record<PendingApproval["requestKind"], string> = {
  command: "command",
  "file-change": "file change",
  "file-read": "file read",
};

const THREAD_REFRESH_DEBOUNCE_MS = 120;
const SNAPSHOT_REFRESH_INTERVAL_MS = 45_000;
const SUBSCRIPTION_RETRY_DELAY_MS = 500;
const NOTIFICATION_BODY_MAX_CHARS = 160;

export interface BackgroundNotificationSettings {
  readonly notifyOnAgentCompletion: boolean;
  readonly notifyOnApprovalRequired: boolean;
  readonly notifyOnUserInputRequired: boolean;
}

export interface ThreadAttentionState {
  readonly notifiedCompletionAt: string | null;
  readonly openApprovalRequestIds: ReadonlySet<string>;
  readonly openUserInputRequestIds: ReadonlySet<string>;
}

export interface AttentionNotificationDescriptor {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string;
  readonly kind: "approval" | "user-input" | "completion";
}

export interface ApplyThreadAttentionStateInput {
  readonly thread: OrchestrationThread;
  readonly previousState?: ThreadAttentionState | undefined;
  readonly settings: BackgroundNotificationSettings;
  readonly notificationSessionStartedAt: string;
  readonly isAppFocused: boolean;
}

export interface ApplyThreadAttentionStateResult {
  readonly nextState: ThreadAttentionState;
  readonly notify: ReadonlyArray<AttentionNotificationDescriptor>;
  readonly closeNotificationIds: ReadonlyArray<string>;
}

interface PendingApproval {
  readonly requestId: string;
  readonly requestKind: "command" | "file-read" | "file-change";
  readonly createdAt: string;
  readonly detail?: string;
}

interface PendingUserInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly firstQuestion: string;
  readonly questionCount: number;
}

export interface DesktopBackgroundNotificationServiceInput {
  readonly wsUrl: string;
  readonly isAppFocused: () => boolean;
  readonly showNotification: (input: DesktopNotificationInput) => boolean;
  readonly closeNotification: (id: string) => boolean;
  readonly log: (message: string) => void;
}

export interface DesktopBackgroundNotificationService {
  readonly stop: () => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function normalizeThreadTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled thread";
}

function truncateNotificationBody(value: string, maxLength = NOTIFICATION_BODY_MAX_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildRequestNotificationKey(threadId: string, requestId: string): string {
  return `${threadId}:${requestId}`;
}

function buildCompletionNotificationKey(threadId: string, completedAt: string): string {
  return `${threadId}:completion:${completedAt}`;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
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
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

function compareActivityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  const leftSequence = typeof left.sequence === "number" ? left.sequence : null;
  const rightSequence = typeof right.sequence === "number" ? right.sequence : null;
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.id.localeCompare(right.id);
}

function parseUserInputRequest(
  payload: Record<string, unknown> | null,
): { readonly firstQuestion: string; readonly questionCount: number } | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return null;
  }
  const prompts = questions
    .map((entry) => asTrimmedString(asRecord(entry)?.question))
    .filter((value): value is string => value !== null);
  const [firstQuestion] = prompts;
  if (!firstQuestion) {
    return null;
  }
  return {
    firstQuestion,
    questionCount: prompts.length,
  };
}

function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<string, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivityOrder);

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const requestId = asTrimmedString(payload?.requestId);
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : requestKindFromRequestType(payload?.requestType);
    const detail = asTrimmedString(payload?.detail) ?? undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<string, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivityOrder);

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    const requestId = asTrimmedString(payload?.requestId);
    const detail = asTrimmedString(payload?.detail) ?? undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const parsed = parseUserInputRequest(payload);
      if (!parsed) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        firstQuestion: parsed.firstQuestion,
        questionCount: parsed.questionCount,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function findLatestAssistantCompletionMessage(thread: OrchestrationThread): string | null {
  const assistantMessageId = thread.latestTurn?.assistantMessageId;
  if (assistantMessageId) {
    const matching = thread.messages.find((message) => message.id === assistantMessageId);
    const text = asTrimmedString(matching?.role === "assistant" ? matching.text : null);
    if (text) {
      return text;
    }
  }

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const candidate = thread.messages[index];
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    const text = asTrimmedString(candidate.text);
    if (text) {
      return text;
    }
  }

  return null;
}

function resolveBackgroundNotificationSettings(
  settings: ServerSettings,
): BackgroundNotificationSettings {
  return {
    notifyOnAgentCompletion: settings.notifyOnAgentCompletion,
    notifyOnApprovalRequired: settings.notifyOnApprovalRequired,
    notifyOnUserInputRequired: settings.notifyOnUserInputRequired,
  };
}

function listTrackedNotificationIds(
  threadId: string,
  state: ThreadAttentionState,
): ReadonlyArray<string> {
  const ids: string[] = [];
  for (const requestId of state.openApprovalRequestIds) {
    ids.push(buildRequestNotificationKey(threadId, requestId));
  }
  for (const requestId of state.openUserInputRequestIds) {
    ids.push(buildRequestNotificationKey(threadId, requestId));
  }
  if (state.notifiedCompletionAt) {
    ids.push(buildCompletionNotificationKey(threadId, state.notifiedCompletionAt));
  }
  return ids;
}

export function applyThreadAttentionState(
  input: ApplyThreadAttentionStateInput,
): ApplyThreadAttentionStateResult {
  const threadId = String(input.thread.id);
  const threadTitle = normalizeThreadTitle(input.thread.title);
  const deepLink = `/${threadId}`;
  const previousState = input.previousState;
  const previousApprovalIds = new Set(previousState?.openApprovalRequestIds ?? []);
  const previousUserInputIds = new Set(previousState?.openUserInputRequestIds ?? []);
  const pendingApprovals = derivePendingApprovals(input.thread.activities);
  const pendingUserInputs = derivePendingUserInputs(input.thread.activities);
  const nextApprovalIds = new Set(pendingApprovals.map((approval) => approval.requestId));
  const nextUserInputIds = new Set(pendingUserInputs.map((request) => request.requestId));
  const closeNotificationIds: string[] = [];
  const notifications: AttentionNotificationDescriptor[] = [];

  for (const requestId of previousApprovalIds) {
    if (!nextApprovalIds.has(requestId)) {
      closeNotificationIds.push(buildRequestNotificationKey(threadId, requestId));
    }
  }
  for (const requestId of previousUserInputIds) {
    if (!nextUserInputIds.has(requestId)) {
      closeNotificationIds.push(buildRequestNotificationKey(threadId, requestId));
    }
  }

  const completionAt =
    input.thread.latestTurn?.state === "completed" ? input.thread.latestTurn.completedAt : null;
  const previousCompletionAt = previousState?.notifiedCompletionAt ?? null;
  if (previousCompletionAt && previousCompletionAt !== completionAt) {
    closeNotificationIds.push(buildCompletionNotificationKey(threadId, previousCompletionAt));
  }

  if (!input.isAppFocused) {
    if (input.settings.notifyOnApprovalRequired) {
      for (const approval of pendingApprovals) {
        if (previousApprovalIds.has(approval.requestId)) {
          continue;
        }
        notifications.push({
          id: buildRequestNotificationKey(threadId, approval.requestId),
          title: `Approval needed: ${threadTitle}`,
          body: truncateNotificationBody(
            approval.detail && approval.detail.length > 0
              ? approval.detail
              : `The agent is waiting for ${APPROVAL_COPY_BY_KIND[approval.requestKind]} approval.`,
          ),
          deepLink,
          kind: "approval",
        });
      }
    }

    if (input.settings.notifyOnUserInputRequired) {
      for (const request of pendingUserInputs) {
        if (previousUserInputIds.has(request.requestId)) {
          continue;
        }
        const suffix =
          request.questionCount > 1 ? ` (${String(request.questionCount)} questions waiting)` : "";
        notifications.push({
          id: buildRequestNotificationKey(threadId, request.requestId),
          title: `Input needed: ${threadTitle}`,
          body: truncateNotificationBody(`${request.firstQuestion}${suffix}`),
          deepLink,
          kind: "user-input",
        });
      }
    }
  }

  let nextNotifiedCompletionAt = previousCompletionAt;
  if (
    completionAt &&
    completionAt < input.notificationSessionStartedAt &&
    nextNotifiedCompletionAt === null
  ) {
    nextNotifiedCompletionAt = completionAt;
  }

  if (
    completionAt &&
    completionAt >= input.notificationSessionStartedAt &&
    completionAt !== nextNotifiedCompletionAt &&
    input.settings.notifyOnAgentCompletion &&
    !input.isAppFocused
  ) {
    const assistantPreview = findLatestAssistantCompletionMessage(input.thread);
    notifications.push({
      id: buildCompletionNotificationKey(threadId, completionAt),
      title: `Agent finished: ${threadTitle}`,
      body: truncateNotificationBody(assistantPreview ?? "The agent finished working."),
      deepLink,
      kind: "completion",
    });
    nextNotifiedCompletionAt = completionAt;
  }

  return {
    nextState: {
      notifiedCompletionAt: nextNotifiedCompletionAt,
      openApprovalRequestIds: nextApprovalIds,
      openUserInputRequestIds: nextUserInputIds,
    },
    notify: notifications,
    closeNotificationIds,
  };
}

function resolveRpcTarget(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  parsed.pathname = "/ws";
  return parsed.toString();
}

class DesktopBackgroundNotificationServiceImpl implements DesktopBackgroundNotificationService {
  private readonly isAppFocused: () => boolean;
  private readonly showNotification: (input: DesktopNotificationInput) => boolean;
  private readonly closeNotification: (id: string) => boolean;
  private readonly log: (message: string) => void;
  private readonly notificationSessionStartedAt = new Date().toISOString();
  private readonly identity = {
    clientSessionId: Crypto.randomUUID(),
    connectionId: Crypto.randomUUID(),
  };
  private readonly wsTarget: string;

  private runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> | null = null;
  private clientScope: Scope.Closeable | null = null;
  private clientPromise: Promise<WsRpcProtocolClient> | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly threadStateById = new Map<string, ThreadAttentionState>();
  private pendingRefreshThreadIds = new Set<string>();
  private queuedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  private settings: BackgroundNotificationSettings = {
    notifyOnAgentCompletion: true,
    notifyOnApprovalRequired: true,
    notifyOnUserInputRequired: true,
  };
  private stopped = false;

  constructor(input: DesktopBackgroundNotificationServiceInput) {
    this.wsTarget = resolveRpcTarget(input.wsUrl);
    this.isAppFocused = input.isAppFocused;
    this.showNotification = input.showNotification;
    this.closeNotification = input.closeNotification;
    this.log = input.log;
  }

  start(): void {
    if (this.stopped) {
      return;
    }

    this.log("notification service starting");
    this.initializeRpcRuntime();
    this.unsubscribers.push(
      this.subscribe(
        (client) => client[WS_METHODS.subscribeServerConfig](this.identity),
        (event) => this.handleServerConfigEvent(event),
      ),
      this.subscribe(
        (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents](this.identity),
        (event) => this.handleOrchestrationEvent(event),
      ),
    );

    void this.refreshSettingsAndSnapshot("startup");
    this.periodicSnapshotTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      void this.refreshSettingsAndSnapshot("interval");
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.queuedRefreshTimer) {
      clearTimeout(this.queuedRefreshTimer);
      this.queuedRefreshTimer = null;
    }
    if (this.periodicSnapshotTimer) {
      clearInterval(this.periodicSnapshotTimer);
      this.periodicSnapshotTimer = null;
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.pendingRefreshThreadIds = new Set<string>();

    const runtime = this.runtime;
    const clientScope = this.clientScope;
    this.runtime = null;
    this.clientScope = null;
    this.clientPromise = null;

    if (runtime && clientScope) {
      try {
        await runtime.runPromise(Scope.close(clientScope, Exit.void));
      } catch (error) {
        this.log(`notification service scope close failed: ${formatErrorMessage(error)}`);
      } finally {
        runtime.dispose();
      }
    }
    this.log("notification service stopped");
  }

  private initializeRpcRuntime(): void {
    if (this.runtime && this.clientScope && this.clientPromise) {
      return;
    }
    this.runtime = ManagedRuntime.make(
      createWsRpcProtocolLayer({
        target: this.wsTarget,
        identity: this.identity,
      }),
    );
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeWsRpcProtocolClient),
    );
  }

  private subscribe<TEvent>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TEvent, Error, never>,
    listener: (event: TEvent) => void,
  ): () => void {
    const runtime = this.runtime;
    const clientPromise = this.clientPromise;
    if (!runtime || !clientPromise) {
      return () => undefined;
    }

    let active = true;
    const cancel = runtime.runCallback(
      Effect.promise(() => clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (event) =>
            Effect.sync(() => {
              if (!active || this.stopped) {
                return;
              }
              listener(event);
            }),
          ),
        ),
        Effect.catch((error) => {
          if (!active || this.stopped) {
            return Effect.interrupt;
          }
          this.log(`notification service subscription disconnected: ${formatErrorMessage(error)}`);
          return Effect.sleep(Duration.millis(SUBSCRIPTION_RETRY_DELAY_MS));
        }),
        Effect.forever,
      ),
    );

    return () => {
      active = false;
      cancel();
    };
  }

  private async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
  ): Promise<TSuccess> {
    const runtime = this.runtime;
    const clientPromise = this.clientPromise;
    if (!runtime || !clientPromise) {
      throw new Error("notification service RPC runtime unavailable");
    }
    const client = await clientPromise;
    return await runtime.runPromise(Effect.suspend(() => execute(client)));
  }

  private async refreshSettingsAndSnapshot(reason: string): Promise<void> {
    try {
      const [settings, snapshot] = await Promise.all([
        this.request((client) => client[WS_METHODS.serverGetSettings]({})),
        this.request((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      ]);
      this.settings = resolveBackgroundNotificationSettings(settings);
      const activeThreadIds = new Set(snapshot.threads.map((thread) => String(thread.id)));
      for (const thread of snapshot.threads) {
        this.processThread(thread);
      }
      for (const [threadId, state] of this.threadStateById) {
        if (activeThreadIds.has(threadId)) {
          continue;
        }
        this.closeTrackedThreadNotifications(threadId, state);
        this.threadStateById.delete(threadId);
      }
    } catch (error) {
      this.log(
        `notification service snapshot refresh failed (${reason}): ${formatErrorMessage(error)}`,
      );
    }
  }

  private handleServerConfigEvent(event: ServerConfigStreamEvent): void {
    if (event.type === "snapshot") {
      this.settings = resolveBackgroundNotificationSettings(event.config.settings);
      return;
    }
    if (event.type === "settingsUpdated") {
      this.settings = resolveBackgroundNotificationSettings(event.payload.settings);
    }
  }

  private handleOrchestrationEvent(event: OrchestrationEvent): void {
    const threadId = this.readThreadIdFromEvent(event);
    if (!threadId) {
      return;
    }
    if (event.type === "thread.deleted" || event.type === "thread.archived") {
      const previousState = this.threadStateById.get(threadId);
      if (previousState) {
        this.closeTrackedThreadNotifications(threadId, previousState);
        this.threadStateById.delete(threadId);
      }
      return;
    }

    this.queueThreadRefresh(threadId);
  }

  private readThreadIdFromEvent(event: OrchestrationEvent): string | null {
    if (event.aggregateKind === "thread" && typeof event.aggregateId === "string") {
      return event.aggregateId;
    }
    const payload = asRecord(event.payload);
    return asTrimmedString(payload?.threadId);
  }

  private queueThreadRefresh(threadId: string): void {
    this.pendingRefreshThreadIds.add(threadId);
    if (this.queuedRefreshTimer !== null) {
      return;
    }
    this.queuedRefreshTimer = setTimeout(() => {
      this.queuedRefreshTimer = null;
      void this.flushQueuedThreadRefreshes();
    }, THREAD_REFRESH_DEBOUNCE_MS);
  }

  private async flushQueuedThreadRefreshes(): Promise<void> {
    const threadIds = [...this.pendingRefreshThreadIds];
    this.pendingRefreshThreadIds = new Set<string>();
    for (const threadId of threadIds) {
      if (this.stopped) {
        return;
      }
      await this.refreshThread(threadId);
    }
  }

  private async refreshThread(threadId: string): Promise<void> {
    try {
      const thread = await this.request((client) =>
        client[ORCHESTRATION_WS_METHODS.getThread]({ threadId: ThreadId.makeUnsafe(threadId) }),
      );
      this.processThread(thread);
    } catch (error) {
      this.log(
        `notification service thread refresh failed thread=${threadId}: ${formatErrorMessage(error)}`,
      );
      const previousState = this.threadStateById.get(threadId);
      if (previousState) {
        this.closeTrackedThreadNotifications(threadId, previousState);
        this.threadStateById.delete(threadId);
      }
    }
  }

  private processThread(thread: OrchestrationThread): void {
    const threadId = String(thread.id);
    const previousState = this.threadStateById.get(threadId);
    const result = applyThreadAttentionState({
      thread,
      previousState,
      settings: this.settings,
      notificationSessionStartedAt: this.notificationSessionStartedAt,
      isAppFocused: this.isAppFocused(),
    });

    for (const notificationId of result.closeNotificationIds) {
      this.closeNotification(notificationId);
    }
    for (const notification of result.notify) {
      const shown = this.showNotification({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        deepLink: notification.deepLink,
      });
      if (!shown) {
        this.log(
          `notification service failed to show ${notification.kind} notification id=${notification.id}`,
        );
      }
    }

    this.threadStateById.set(threadId, result.nextState);
  }

  private closeTrackedThreadNotifications(threadId: string, state: ThreadAttentionState): void {
    for (const notificationId of listTrackedNotificationIds(threadId, state)) {
      this.closeNotification(notificationId);
    }
  }
}

export function startDesktopBackgroundNotificationService(
  input: DesktopBackgroundNotificationServiceInput,
): DesktopBackgroundNotificationService {
  const service = new DesktopBackgroundNotificationServiceImpl(input);
  service.start();
  return service;
}
