import type { OrchestrationEvent } from "@ace/contracts";

export interface MobileNotification {
  readonly title: string;
  readonly body: string;
}

const MAX_NOTIFICATION_BODY_CHARS = 120;

function truncate(text: string, maxChars = MAX_NOTIFICATION_BODY_CHARS): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

export function notificationFromDomainEvent(event: OrchestrationEvent): MobileNotification | null {
  switch (event.type) {
    case "thread.message-sent": {
      if (event.payload.role !== "assistant" || event.payload.streaming) {
        return null;
      }
      return {
        title: "Assistant reply",
        body:
          truncate(event.payload.text) ||
          `New assistant message on thread ${String(event.payload.threadId)}.`,
      };
    }
    case "thread.activity-appended": {
      const { activity } = event.payload;
      if (activity.kind === "approval.requested") {
        return {
          title: "Approval requested",
          body: truncate(activity.summary),
        };
      }
      if (activity.kind === "user-input.requested") {
        return {
          title: "Input requested",
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
        title: "Session error",
        body: session.lastError
          ? truncate(session.lastError)
          : "A provider session reported an error.",
      };
    }
    default:
      return null;
  }
}
