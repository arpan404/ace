import type {
  ApprovalRequestId,
  DesktopBridge,
  DesktopNotificationInput,
  ThreadId,
  UserInputQuestion,
} from "@ace/contracts";
import {
  buildAgentAttentionNotificationTitle,
  buildApprovalNotificationBody,
  buildCompletionNotificationBody,
  buildUserInputNotificationBody,
  normalizeThreadNotificationTitle,
  truncateNotificationText,
} from "@ace/shared/notifications";

import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import type { ChatMessage, Thread } from "../types";

type AgentAttentionMessageLike = Pick<ChatMessage, "id" | "role" | "text" | "createdAt"> &
  Partial<Pick<ChatMessage, "completedAt">> & {
    updatedAt?: string | undefined;
    streaming?: boolean | undefined;
  };

type AgentAttentionThreadLike = {
  id: ThreadId;
  title: string;
  activities: ReadonlyArray<Thread["activities"][number]>;
  latestTurn: {
    state: string;
    completedAt?: string | null;
    assistantMessageId?: string | null;
  } | null;
  session: {
    orchestrationStatus?: string | null | undefined;
    activeTurnId?: string | null | undefined;
  } | null;
  messages: ReadonlyArray<AgentAttentionMessageLike>;
};

export type AgentAttentionNotificationPermission = NotificationPermission | "unsupported";
export type AgentAttentionNotificationConstructor = typeof Notification;
export type AgentAttentionNotificationPermissionSource = Pick<
  AgentAttentionNotificationConstructor,
  "permission" | "requestPermission"
>;
export type AgentAttentionDesktopNotificationBridge = Pick<
  DesktopBridge,
  "showNotification" | "closeNotification" | "onNotificationClick" | "onNotificationReply"
>;

interface AgentAttentionRequestBase {
  key: string;
  threadId: ThreadId;
  threadTitle: string;
  createdAt: string;
  body: string;
  deepLink: string;
}

export interface ApprovalAttentionRequest extends AgentAttentionRequestBase {
  kind: "approval";
  requestId: ApprovalRequestId;
}

export interface UserInputAttentionRequest extends AgentAttentionRequestBase {
  kind: "user-input";
  requestId: ApprovalRequestId;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface CompletionAttentionRequest extends AgentAttentionRequestBase {
  kind: "completion";
}

export type AgentAttentionRequest =
  | ApprovalAttentionRequest
  | UserInputAttentionRequest
  | CompletionAttentionRequest;

export interface AgentAttentionNotificationReplyResult {
  answers: Record<string, string | string[]>;
}

export interface AgentAttentionNotificationSettings {
  notifyOnAgentCompletion: boolean;
  notifyOnApprovalRequired: boolean;
  notifyOnUserInputRequired: boolean;
}

const DEFAULT_HISTORICAL_REQUEST_THRESHOLD_MS = 0;

function buildAgentAttentionRequestKey(threadId: ThreadId, requestId: ApprovalRequestId): string {
  return `${threadId}:${requestId}`;
}

function buildCompletionAttentionRequestKey(threadId: ThreadId, completedAt: string): string {
  return `${threadId}:completion:${completedAt}`;
}

function buildThreadDeepLink(threadId: ThreadId): string {
  return `/${threadId}`;
}

function findLatestAssistantCompletionMessage(
  thread: AgentAttentionThreadLike,
): AgentAttentionMessageLike | null {
  const assistantMessageId = thread.latestTurn?.assistantMessageId;
  if (assistantMessageId) {
    const matchingMessage = thread.messages.find((message) => message.id === assistantMessageId);
    if (matchingMessage?.role === "assistant") {
      return matchingMessage;
    }
  }

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (
      message?.role === "assistant" &&
      (message.completedAt || (message.updatedAt && message.streaming !== true))
    ) {
      return message;
    }
  }

  return null;
}

function buildCompletionAttentionBody(thread: AgentAttentionThreadLike): string {
  const assistantMessage = findLatestAssistantCompletionMessage(thread);
  return buildCompletionNotificationBody({ assistantPreview: assistantMessage?.text ?? null });
}

function isCompletionNotificationEligible(thread: AgentAttentionThreadLike): boolean {
  const latestTurn = thread.latestTurn;
  if (!latestTurn || latestTurn.state !== "completed" || !latestTurn.completedAt) {
    return false;
  }
  const orchestrationStatus = thread.session?.orchestrationStatus;
  if (orchestrationStatus === "starting" || orchestrationStatus === "running") {
    return false;
  }
  if (thread.session?.activeTurnId) {
    return false;
  }
  return true;
}

function buildReplyPlaceholder(question: UserInputQuestion): string | undefined {
  if (question.multiSelect === true) {
    return "Reply with one or more answers, separated by commas";
  }

  const [firstOption] = question.options;
  if (question.options.length === 1 && firstOption) {
    return `Reply with ${firstOption.label}`;
  }

  if (question.options.length > 1 && question.options.length <= 3) {
    return `Reply with ${question.options.map((option) => option.label).join(", ")}`;
  }

  return "Reply with your answer";
}

function splitNotificationReplyValues(response: string): string[] {
  return response
    .split(/[,\n;]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function resolveAgentAttentionNotificationReply(
  request: AgentAttentionRequest,
  response: string,
): AgentAttentionNotificationReplyResult | null {
  if (request.kind !== "user-input") {
    return null;
  }

  const question = request.questions[0];
  if (!question || request.questions.length !== 1) {
    return null;
  }

  if (question.multiSelect === true) {
    const answers = splitNotificationReplyValues(response);
    if (answers.length === 0) {
      return null;
    }

    return {
      answers: {
        [question.id]: answers,
      },
    };
  }

  const answer = response.trim();
  if (answer.length === 0) {
    return null;
  }

  return {
    answers: {
      [question.id]: answer,
    },
  };
}

export function deriveAgentAttentionRequests(
  threads: ReadonlyArray<AgentAttentionThreadLike>,
): AgentAttentionRequest[] {
  const requests: AgentAttentionRequest[] = [];

  for (const thread of threads) {
    const threadTitle = normalizeThreadNotificationTitle(thread.title);
    const deepLink = buildThreadDeepLink(thread.id);

    for (const approval of derivePendingApprovals(thread.activities)) {
      requests.push({
        key: buildAgentAttentionRequestKey(thread.id, approval.requestId),
        requestId: approval.requestId,
        threadId: thread.id,
        threadTitle,
        kind: "approval",
        createdAt: approval.createdAt,
        body: buildApprovalNotificationBody({
          requestKind: approval.requestKind,
          detail: approval.detail ?? null,
        }),
        deepLink,
      });
    }

    for (const userInput of derivePendingUserInputs(thread.activities)) {
      const firstQuestion = userInput.questions[0];
      if (!firstQuestion) {
        continue;
      }

      requests.push({
        key: buildAgentAttentionRequestKey(thread.id, userInput.requestId),
        requestId: userInput.requestId,
        threadId: thread.id,
        threadTitle,
        kind: "user-input",
        createdAt: userInput.createdAt,
        body: buildUserInputNotificationBody({
          firstQuestion: firstQuestion.question,
          questionCount: userInput.questions.length,
        }),
        deepLink,
        questions: userInput.questions,
      });
    }

    if (isCompletionNotificationEligible(thread) && thread.latestTurn?.completedAt) {
      const completedAt = thread.latestTurn.completedAt;
      requests.push({
        key: buildCompletionAttentionRequestKey(thread.id, completedAt),
        threadId: thread.id,
        threadTitle,
        kind: "completion",
        createdAt: completedAt,
        body: buildCompletionAttentionBody(thread),
        deepLink,
      });
    }
  }

  return requests.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function filterAgentAttentionRequestsBySettings<T extends AgentAttentionRequest>(
  requests: ReadonlyArray<T>,
  settings: AgentAttentionNotificationSettings,
): T[] {
  return requests.filter((request) => {
    switch (request.kind) {
      case "approval":
        return settings.notifyOnApprovalRequired;
      case "user-input":
        return settings.notifyOnUserInputRequired;
      case "completion":
        return settings.notifyOnAgentCompletion;
    }
  });
}

export function buildAgentAttentionNotificationCopy(request: AgentAttentionRequest): {
  title: string;
  body: string;
  tag: string;
} {
  return {
    title: buildAgentAttentionNotificationTitle({
      kind: request.kind,
      threadTitle: request.threadTitle,
    }),
    body: truncateNotificationText(request.body),
    tag: `ace-agent-attention:${request.key}`,
  };
}

export function buildAgentAttentionDesktopNotificationInput(
  request: AgentAttentionRequest,
): DesktopNotificationInput {
  const { title, body } = buildAgentAttentionNotificationCopy(request);
  const firstQuestion = request.kind === "user-input" ? request.questions[0] : null;
  const replyPlaceholder =
    request.kind === "user-input" && request.questions.length === 1 && firstQuestion
      ? buildReplyPlaceholder(firstQuestion)
      : null;

  return {
    id: request.key,
    title,
    body,
    deepLink: request.deepLink,
    ...(replyPlaceholder !== null
      ? {
          reply: replyPlaceholder ? { placeholder: replyPlaceholder } : {},
        }
      : {}),
  };
}

export function isAppWindowFocused(
  documentLike: Pick<Document, "visibilityState" | "hasFocus">,
): boolean {
  return documentLike.visibilityState === "visible" && documentLike.hasFocus();
}

export function getAgentAttentionDesktopNotificationBridge(
  bridge: Partial<DesktopBridge> | null | undefined,
): AgentAttentionDesktopNotificationBridge | null {
  const showNotification = bridge?.showNotification;
  const closeNotification = bridge?.closeNotification;
  const onNotificationClick = bridge?.onNotificationClick;
  const onNotificationReply = bridge?.onNotificationReply;
  if (
    typeof showNotification !== "function" ||
    typeof closeNotification !== "function" ||
    typeof onNotificationClick !== "function" ||
    typeof onNotificationReply !== "function"
  ) {
    return null;
  }

  return {
    showNotification,
    closeNotification,
    onNotificationClick,
    onNotificationReply,
  };
}

export function collectAgentAttentionRequestsToNotify<T extends AgentAttentionRequest>(input: {
  requests: ReadonlyArray<T>;
  notifiedRequestKeys: ReadonlySet<string>;
  isAppFocused: boolean;
  notificationSessionStartedAt?: string;
  historicalRequestThresholdMs?: number;
}): T[] {
  if (input.isAppFocused) {
    return [];
  }

  const sessionStartedAtMs =
    typeof input.notificationSessionStartedAt === "string"
      ? Date.parse(input.notificationSessionStartedAt)
      : Number.NaN;
  const historicalRequestThresholdMs = Math.max(
    0,
    Math.floor(input.historicalRequestThresholdMs ?? DEFAULT_HISTORICAL_REQUEST_THRESHOLD_MS),
  );
  const staleRequestCutoffMs = Number.isNaN(sessionStartedAtMs)
    ? Number.NaN
    : sessionStartedAtMs - historicalRequestThresholdMs;

  return input.requests.filter((request) => {
    if (input.notifiedRequestKeys.has(request.key)) {
      return false;
    }

    if (!Number.isNaN(sessionStartedAtMs)) {
      const createdAtMs = Date.parse(request.createdAt);
      if (!Number.isNaN(createdAtMs)) {
        if (request.kind === "completion" && createdAtMs < sessionStartedAtMs) {
          return false;
        }
        if (request.kind !== "completion" && createdAtMs < staleRequestCutoffMs) {
          return false;
        }
      }
    }

    return true;
  });
}

export function shouldOfferAgentAttentionNotificationPermission(input: {
  permission: AgentAttentionNotificationPermission;
  hasPendingRequests: boolean;
  isAppFocused: boolean;
  hasPromptedForPermission: boolean;
}): boolean {
  return (
    input.permission === "default" &&
    input.hasPendingRequests &&
    input.isAppFocused &&
    !input.hasPromptedForPermission
  );
}

export function getAgentAttentionNotificationConstructor(): AgentAttentionNotificationConstructor | null {
  if (typeof globalThis.Notification !== "function") {
    return null;
  }

  return globalThis.Notification;
}

export function readAgentAttentionNotificationPermission(
  notificationSource: AgentAttentionNotificationPermissionSource | null = getAgentAttentionNotificationConstructor(),
): AgentAttentionNotificationPermission {
  return notificationSource?.permission ?? "unsupported";
}

export async function requestAgentAttentionNotificationPermission(
  notificationSource: AgentAttentionNotificationPermissionSource | null = getAgentAttentionNotificationConstructor(),
): Promise<AgentAttentionNotificationPermission> {
  if (!notificationSource) {
    return "unsupported";
  }

  return await notificationSource.requestPermission();
}
