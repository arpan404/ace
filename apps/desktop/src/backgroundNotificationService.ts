import {
  type DesktopNotificationInput,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ServerConfigStreamEvent,
  type ServerSettings,
} from "@ace/contracts";
import {
  buildAgentAttentionNotificationTitle,
  buildApprovalNotificationBody,
  buildCompletionNotificationBody,
  buildUserInputNotificationBody,
  normalizeThreadNotificationTitle,
} from "@ace/shared/notifications";

const THREAD_REFRESH_DEBOUNCE_MS = 120;
const SNAPSHOT_REFRESH_INTERVAL_MS = 45_000;
const FOCUS_STATE_POLL_INTERVAL_MS = 1_000;
const ATTENTION_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

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
  readonly onOrchestrationEvent: (event: OrchestrationEvent) => void;
  readonly onServerConfigEvent: (event: ServerConfigStreamEvent) => void;
  readonly isAppFocused: () => boolean;
  readonly showNotification: (input: DesktopNotificationInput) => boolean;
  readonly closeNotification: (id: string) => boolean;
  readonly log: (message: string) => void;
}

export interface DesktopBackgroundNotificationService {
  readonly handleOrchestrationEvent: (event: OrchestrationEvent) => void;
  readonly handleServerConfigEvent: (event: ServerConfigStreamEvent) => void;
  readonly stop: () => Promise<void>;
}

export function shouldRefreshThreadAttentionForEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.activity-appended":
      return ATTENTION_ACTIVITY_KINDS.has(event.payload.activity.kind);
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.session-stop-requested":
    case "thread.session-set":
    case "thread.turn-diff-completed":
    case "thread.reverted":
      return true;
    default:
      return false;
  }
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

function buildRequestNotificationKey(threadId: string, requestId: string): string {
  return `${threadId}:${requestId}`;
}

function buildCompletionNotificationKey(threadId: string, completedAt: string): string {
  return `${threadId}:completion:${completedAt}`;
}

function isIsoTimestampOnOrAfter(value: string, threshold: string): boolean {
  const valueAtMs = Date.parse(value);
  const thresholdAtMs = Date.parse(threshold);
  if (!Number.isFinite(valueAtMs) || !Number.isFinite(thresholdAtMs)) {
    return value.localeCompare(threshold) >= 0;
  }
  return valueAtMs >= thresholdAtMs;
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

function isCompletionNotificationEligible(thread: OrchestrationThread): boolean {
  const latestTurn = thread.latestTurn;
  if (!latestTurn || latestTurn.state !== "completed" || !latestTurn.completedAt) {
    return false;
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return false;
  }
  if (thread.session?.activeTurnId) {
    return false;
  }
  return true;
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
  const threadTitle = normalizeThreadNotificationTitle(input.thread.title);
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
    isCompletionNotificationEligible(input.thread) && input.thread.latestTurn?.completedAt
      ? input.thread.latestTurn.completedAt
      : null;
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
        if (!isIsoTimestampOnOrAfter(approval.createdAt, input.notificationSessionStartedAt)) {
          continue;
        }
        notifications.push({
          id: buildRequestNotificationKey(threadId, approval.requestId),
          title: buildAgentAttentionNotificationTitle({ kind: "approval", threadTitle }),
          body: buildApprovalNotificationBody({
            requestKind: approval.requestKind,
            detail: approval.detail ?? null,
          }),
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
        if (!isIsoTimestampOnOrAfter(request.createdAt, input.notificationSessionStartedAt)) {
          continue;
        }
        notifications.push({
          id: buildRequestNotificationKey(threadId, request.requestId),
          title: buildAgentAttentionNotificationTitle({ kind: "user-input", threadTitle }),
          body: buildUserInputNotificationBody({
            firstQuestion: request.firstQuestion,
            questionCount: request.questionCount,
          }),
          deepLink,
          kind: "user-input",
        });
      }
    }
  }

  let nextNotifiedCompletionAt = previousCompletionAt;
  if (
    completionAt &&
    !isIsoTimestampOnOrAfter(completionAt, input.notificationSessionStartedAt) &&
    nextNotifiedCompletionAt === null
  ) {
    nextNotifiedCompletionAt = completionAt;
  }

  if (
    completionAt &&
    isIsoTimestampOnOrAfter(completionAt, input.notificationSessionStartedAt) &&
    completionAt !== nextNotifiedCompletionAt &&
    input.settings.notifyOnAgentCompletion &&
    !input.isAppFocused
  ) {
    const assistantPreview = findLatestAssistantCompletionMessage(input.thread);
    notifications.push({
      id: buildCompletionNotificationKey(threadId, completionAt),
      title: buildAgentAttentionNotificationTitle({ kind: "completion", threadTitle }),
      body: buildCompletionNotificationBody({ assistantPreview }),
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

class DesktopBackgroundNotificationServiceImpl implements DesktopBackgroundNotificationService {
  private readonly onOrchestrationEvent: (event: OrchestrationEvent) => void;
  private readonly onServerConfigEvent: (event: ServerConfigStreamEvent) => void;
  private readonly isAppFocused: () => boolean;
  private readonly showNotification: (input: DesktopNotificationInput) => boolean;
  private readonly closeNotification: (id: string) => boolean;
  private readonly log: (message: string) => void;
  private notificationSessionStartedAt = new Date().toISOString();
  private lastKnownFocusState: boolean | null = null;
  private readonly threadStateById = new Map<string, ThreadAttentionState>();
  private pendingRefreshThreadIds = new Set<string>();
  private queuedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicSnapshotTimer: ReturnType<typeof setInterval> | null = null;
  private focusStatePollTimer: ReturnType<typeof setInterval> | null = null;
  private settings: BackgroundNotificationSettings = {
    notifyOnAgentCompletion: true,
    notifyOnApprovalRequired: true,
    notifyOnUserInputRequired: true,
  };
  private stopped = false;

  constructor(input: DesktopBackgroundNotificationServiceInput) {
    this.onOrchestrationEvent = input.onOrchestrationEvent;
    this.onServerConfigEvent = input.onServerConfigEvent;
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
    this.syncNotificationSessionFromFocus(new Date().toISOString());

    this.periodicSnapshotTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
    this.focusStatePollTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      this.syncNotificationSessionFromFocus(new Date().toISOString());
    }, FOCUS_STATE_POLL_INTERVAL_MS);
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
    if (this.focusStatePollTimer) {
      clearInterval(this.focusStatePollTimer);
      this.focusStatePollTimer = null;
    }
    this.pendingRefreshThreadIds = new Set<string>();
    this.lastKnownFocusState = null;
    this.log("notification service stopped");
  }

  handleOrchestrationEvent(event: OrchestrationEvent): void {
    if (this.stopped) {
      return;
    }
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

    if (!shouldRefreshThreadAttentionForEvent(event)) {
      return;
    }

    this.queueThreadRefresh(threadId);
  }

  handleServerConfigEvent(event: ServerConfigStreamEvent): void {
    if (this.stopped) {
      return;
    }
    if (event.type === "snapshot") {
      this.settings = resolveBackgroundNotificationSettings(event.config.settings);
      return;
    }
    if (event.type === "settingsUpdated") {
      this.settings = resolveBackgroundNotificationSettings(event.payload.settings);
    }
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
    }, THREAD_REFRESH_DEBOUNCE_MS);
  }

  private syncNotificationSessionFromFocus(nowIso: string): boolean {
    const isFocused = this.isAppFocused();
    if (this.lastKnownFocusState === null) {
      this.lastKnownFocusState = isFocused;
      if (!isFocused) {
        this.notificationSessionStartedAt = nowIso;
      }
      return isFocused;
    }
    if (this.lastKnownFocusState && !isFocused) {
      this.notificationSessionStartedAt = nowIso;
    }
    this.lastKnownFocusState = isFocused;
    return isFocused;
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
