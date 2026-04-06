import type {
  ApprovalRequestId,
  DesktopBridge,
  DesktopNotificationInput,
  ThreadId,
} from "@ace/contracts";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
} from "../session-logic";
import type { Thread } from "../types";

export type AgentAttentionNotificationPermission = NotificationPermission | "unsupported";
export type AgentAttentionNotificationConstructor = typeof Notification;
export type AgentAttentionNotificationPermissionSource = Pick<
  AgentAttentionNotificationConstructor,
  "permission" | "requestPermission"
>;
export type AgentAttentionDesktopNotificationBridge = Pick<
  DesktopBridge,
  "showNotification" | "closeNotification" | "onNotificationClick"
>;

export interface AgentAttentionRequest {
  key: string;
  requestId: ApprovalRequestId;
  threadId: ThreadId;
  threadTitle: string;
  kind: "approval" | "user-input";
  createdAt: string;
  body: string;
}

const APPROVAL_COPY_BY_KIND: Record<PendingApproval["requestKind"], string> = {
  command: "command",
  "file-change": "file change",
  "file-read": "file read",
};

function buildAgentAttentionRequestKey(
  threadId: ThreadId,
  requestId: ApprovalRequestId,
): AgentAttentionRequest["key"] {
  return `${threadId}:${requestId}`;
}

function normalizeThreadTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : "Untitled thread";
}

function truncateNotificationBody(text: string, maxLength = 160): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function deriveAgentAttentionRequests(
  threads: ReadonlyArray<Thread>,
): AgentAttentionRequest[] {
  const requests: AgentAttentionRequest[] = [];

  for (const thread of threads) {
    if (thread.activities.length === 0) {
      continue;
    }

    const threadTitle = normalizeThreadTitle(thread.title);

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
      });
    }
  }

  return requests.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function buildAgentAttentionNotificationCopy(request: AgentAttentionRequest): {
  title: string;
  body: string;
  tag: string;
} {
  return {
    title: `${request.kind === "approval" ? "Approval needed" : "Input needed"}: ${request.threadTitle}`,
    body: request.body,
    tag: `ace-agent-attention:${request.key}`,
  };
}

export function buildAgentAttentionDesktopNotificationInput(
  request: AgentAttentionRequest,
): DesktopNotificationInput {
  const { title, body } = buildAgentAttentionNotificationCopy(request);
  return {
    id: request.key,
    title,
    body,
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
  if (
    typeof showNotification !== "function" ||
    typeof closeNotification !== "function" ||
    typeof onNotificationClick !== "function"
  ) {
    return null;
  }

  return {
    showNotification,
    closeNotification,
    onNotificationClick,
  };
}

export function collectAgentAttentionRequestsToNotify(input: {
  requests: ReadonlyArray<AgentAttentionRequest>;
  notifiedRequestKeys: ReadonlySet<string>;
  isAppFocused: boolean;
}): AgentAttentionRequest[] {
  if (input.isAppFocused) {
    return [];
  }

  return input.requests.filter((request) => !input.notifiedRequestKeys.has(request.key));
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
