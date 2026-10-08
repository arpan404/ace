import type { Notification } from "@ace/protocol/notifications";

/** Keep agent messages named the same in the app and in background browser pushes. */
export function notificationTitle(notice: Pick<Notification, "status" | "title">): string {
  return notice.status === "agent_says" ? `Agent message · ${notice.title}` : notice.title;
}
