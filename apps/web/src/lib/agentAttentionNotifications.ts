import type {
  ApprovalRequestId,
  DesktopBridge,
  DesktopNotificationInput,
  ThreadId,
  UserInputQuestion,
} from "@ace/contracts";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
} from "../session-logic";
import type { ChatMessage, Thread } from "../types";

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

const APPROVAL_COPY_BY_KIND: Record<PendingApproval["requestKind"], string> = {
  command: "command",
  "file-change": "file change",
  "file-read": "file read",
};
const DEFAULT_HISTORICAL_REQUEST_THRESHOLD_MS = 0;

function buildAgentAttentionRequestKey(threadId: ThreadId, requestId: ApprovalRequestId): string {
  return `${threadId}:${requestId}`;
}

function buildCompletionAttentionRequestKey(threadId: ThreadId, completedAt: string): string {
  return `${threadId}:completion:${completedAt}`;
}

function normalizeThreadTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled thread";
}

function normalizeNotificationText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateNotificationBody(text: string, maxLength = 160): string {
  const trimmed = normalizeNotificationText(text);
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function buildThreadDeepLink(threadId: ThreadId): string {
  return `/${threadId}`;
}

function findLatestAssistantCompletionMessage(thread: Thread): ChatMessage | null {
  const assistantMessageId = thread.latestTurn?.assistantMessageId;
  if (assistantMessageId) {
    const matchingMessage = thread.messages.find((message) => message.id === assistantMessageId);
    if (matchingMessage?.role === "assistant") {
      return matchingMessage;
    }
  }

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "assistant" && message.completedAt) {
      return message;
    }
  }

  return null;
}

function buildCompletionNotificationBody(thread: Thread): string {
  const assistantMessage = findLatestAssistantCompletionMessage(thread);
  const text = assistantMessage?.text;
  if (text) {
    return truncateNotificationBody(text);
  }

  return "The agent finished working.";
}

function isCompletionNotificationEligible(thread: Thread): boolean {
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
  threads: ReadonlyArray<Thread>,
): AgentAttentionRequest[] {
  const requests: AgentAttentionRequest[] = [];

  for (const thread of threads) {
    const threadTitle = normalizeThreadTitle(thread.title);
    const deepLink = buildThreadDeepLink(thread.id);

    for (const approval of derivePendingApprovals(thread.activities)) {
      const detail = approval.detail?.trim();
      requests.push({
        key: buildAgentAttentionRequestKey(thread.id, approval.requestId),
        requestId: approval.requestId,
        threadId: thread.id,
        threadTitle,
        kind: "approval",
        createdAt: approval.createdAt,
        body: truncateNotificationBody(
          detail && detail.length > 0
            ? detail
            : `The agent is waiting for ${APPROVAL_COPY_BY_KIND[approval.requestKind]} approval.`,
        ),
        deepLink,
      });
    }

    for (const userInput of derivePendingUserInputs(thread.activities)) {
      const firstQuestion = userInput.questions[0];
      if (!firstQuestion) {
        continue;
      }

      const questionCount = userInput.questions.length;
      const suffix = questionCount > 1 ? ` (${questionCount} questions waiting)` : "";
      requests.push({
        key: buildAgentAttentionRequestKey(thread.id, userInput.requestId),
        requestId: userInput.requestId,
        threadId: thread.id,
        threadTitle,
        kind: "user-input",
        createdAt: userInput.createdAt,
        body: truncateNotificationBody(`${firstQuestion.question}${suffix}`),
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
        body: buildCompletionNotificationBody(thread),
        deepLink,
      });
    }
  }

  return requests.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function filterAgentAttentionRequestsBySettings(
  requests: ReadonlyArray<AgentAttentionRequest>,
  settings: AgentAttentionNotificationSettings,
): AgentAttentionRequest[] {
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
  const prefix =
    request.kind === "approval"
      ? "Approval needed"
      : request.kind === "user-input"
        ? "Input needed"
        : "Agent finished";

  return {
    title: `${prefix}: ${request.threadTitle}`,
    body: request.body,
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

export function collectAgentAttentionRequestsToNotify(input: {
  requests: ReadonlyArray<AgentAttentionRequest>;
  notifiedRequestKeys: ReadonlySet<string>;
  isAppFocused: boolean;
  notificationSessionStartedAt?: string;
  historicalRequestThresholdMs?: number;
}): AgentAttentionRequest[] {
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
