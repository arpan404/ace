import type { OrchestrationEvent } from "@ace/contracts";
import { truncateNotificationText } from "@ace/shared/notifications";

export interface MobileNotification {
  readonly title: string;
  readonly body: string;
}

export interface MobileNotificationThreadRoute {
  readonly hostId: string;
  readonly threadId: string;
}

const MAX_NOTIFICATION_BODY_CHARS = 120;

function truncate(text: string, maxChars = MAX_NOTIFICATION_BODY_CHARS): string {
  return truncateNotificationText(text, maxChars);
}

export function notificationFromDomainEvent(event: OrchestrationEvent): MobileNotification | null {
  switch (event.type) {
    case "thread.message-sent": {
      if (event.payload.role !== "assistant" || event.payload.streaming) {
        return null;
      }
      return {
        title: "Agent replied",
        body:
          truncate(event.payload.text) ||
          `New assistant message on thread ${String(event.payload.threadId)}.`,
      };
    }
    case "thread.activity-appended": {
      const { activity } = event.payload;
      if (activity.kind === "approval.requested") {
        return {
          title: "Approval needed",
          body: truncate(activity.summary),
        };
      }
      if (activity.kind === "user-input.requested") {
        return {
          title: "Input needed",
          body: truncate(activity.summary),
        };
      }
      return null;
    }
    case "thread.session-set": {
      const session = event.payload.session;
      if (session.status !== "error") {
        return null;
      }
      return {
        title: "Session needs attention",
        body: session.lastError
          ? truncate(session.lastError)
          : "A provider session reported an error.",
      };
    }
    default:
      return null;
  }
}

export function notificationThreadRouteFromData(
  data: Readonly<Record<string, unknown>> | null | undefined,
): MobileNotificationThreadRoute | null {
  const threadId = data?.threadId;
  const hostId = data?.hostId;
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  const normalizedHostId = typeof hostId === "string" ? hostId.trim() : "";
  if (normalizedThreadId.length === 0) {
    return null;
  }
  if (normalizedHostId.length === 0) {
    return null;
  }
  return {
    threadId: normalizedThreadId,
    hostId: normalizedHostId,
  };
}
