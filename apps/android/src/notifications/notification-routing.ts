import { HostId, ThreadId, type CommandPayload, type Notification } from "@ace/protocol";
import { z } from "zod";

/**
 * Notification routing (parity slices A14.01/A14.03).
 *
 * Ports the iOS wording and identity rules without copying them:
 * - `AlertContent` (`Sources/Notifications/AlertContent.swift`): title/body,
 *   approval-vs-thread category and passive/active/time-sensitive level.
 * - Request identifiers namespaced per machine (`<hostId>|<id>`), so a repeat
 *   replaces rather than stacks and the same daemon id from two machines is
 *   two notifications; retraction withdraws both the namespaced and the bare
 *   id builds posted before namespacing (ADR 0087).
 * - Tap opens the exact host/thread (cold-start safe via an encoded link);
 *   Allow/Deny answer only the exact pending option through the durable
 *   outbox with a stable command id, so a duplicate tap cannot double-answer.
 */

export type NotificationLevel = "passive" | "active" | "timeSensitive";
export type NotificationCategory = "approval" | "thread";

export interface NotificationDisplay {
  title: string;
  body: string;
  category: NotificationCategory;
  level: NotificationLevel;
  threadId: string;
  interactionId: string | undefined;
  approveOption: string | undefined;
  denyOption: string | undefined;
}

/** The system request identifier for one daemon alert on one machine. */
export function notificationRequestId(alertId: string, hostId?: string | undefined): string {
  return hostId ? `${hostId}|${alertId}` : alertId;
}

/**
 * What to withdraw for a retracted alert: the namespaced id plus the bare id
 * that builds before namespacing posted.
 */
export function retractionRequestIds(alertId: string, hostId?: string | undefined): string[] {
  const namespaced = notificationRequestId(alertId, hostId);
  return namespaced === alertId ? [namespaced] : [namespaced, alertId];
}

export function alertDisplay(
  alert: Notification,
  hostId?: string | undefined,
): NotificationDisplay {
  void hostId;
  const title = alert.title === "" ? "ace" : alert.title;
  const approveOption = alert.actions.find((action) => action.action === "approve")?.optionId;
  const denyOption = alert.actions.find((action) => action.action === "deny")?.optionId;
  const category: NotificationCategory =
    alert.interactionId !== undefined && approveOption !== undefined && denyOption !== undefined
      ? "approval"
      : "thread";
  let phrase: string;
  let level: NotificationLevel;
  switch (alert.status) {
    case "needs_you":
      phrase = "Needs you";
      level = "timeSensitive";
      break;
    case "done":
      phrase = "Done";
      level = "active";
      break;
    case "failed":
      phrase = "Failed";
      level = "active";
      break;
    case "unresponsive":
      phrase = "Not responding";
      level = "active";
      break;
    case "background_done":
      phrase =
        alert.backgroundCount === 1
          ? "1 background task done"
          : `${alert.backgroundCount} background tasks done`;
      level = "passive";
      break;
    case "agent_says":
      phrase = "Agent says";
      level = "active";
      break;
    default:
      // Unknown statuses never claim done.
      phrase = "New activity";
      level = "active";
      break;
  }
  const detail = alert.status === "agent_says" ? alert.message : alert.preview;
  const body = detail === undefined ? phrase : `${phrase}: ${detail}`;
  return {
    title,
    body,
    category,
    level,
    threadId: alert.threadId,
    interactionId: alert.interactionId,
    approveOption,
    denyOption,
  };
}

export interface NotificationTap {
  hostId: string | undefined;
  threadId: string;
}

const tapInfo = z.object({
  threadId: ThreadId,
  hostId: z.string().min(1).max(200).optional(),
});

/** Where a tapped notification routes: the exact host/thread that raised it. */
export function tapRoute(info: {
  threadId: string;
  hostId?: string | undefined;
}): NotificationTap | undefined {
  const parsed = tapInfo.safeParse(info);
  if (!parsed.success) return undefined;
  const host = parsed.data.hostId;
  if (host !== undefined && !HostId.safeParse(host).success) return undefined;
  return { hostId: host, threadId: parsed.data.threadId };
}

export type NotificationUserAction = "approve" | "deny";

/** Stable command id for one alert action: a duplicate tap replays, never double-answers. */
export function notificationActionId(alertId: string, action: NotificationUserAction): string {
  return `notification-${alertId}-${action}`;
}

/**
 * The durable command an Allow/Deny button admits. Only the daemon's fixed
 * approve/deny pair qualifies: anything else (or a missing pending option)
 * admits nothing, so a stale or forged action never answers blindly.
 */
export function notificationActionPayload(
  alert: Notification,
  action: NotificationUserAction,
): CommandPayload | undefined {
  if (alert.interactionId === undefined) return undefined;
  const optionId = alert.actions.find((candidate) => candidate.action === action)?.optionId;
  if (optionId === undefined) return undefined;
  const both =
    alert.actions.some((candidate) => candidate.action === "approve") &&
    alert.actions.some((candidate) => candidate.action === "deny");
  if (!both) return undefined;
  return {
    type: "interaction.resolve",
    interactionId: alert.interactionId,
    resolution: { kind: "approval", optionId },
  };
}

const deepLink = z.object({ hostId: HostId, threadId: ThreadId });

/**
 * Cold-start-safe tap link: opening the app from a notification (including
 * after process death) recovers the exact host/thread. Malformed links read
 * as no route rather than throwing.
 */
export function encodeNotificationLink(tap: NotificationTap): string | undefined {
  if (tap.hostId === undefined) return undefined;
  const parsed = deepLink.safeParse({ hostId: tap.hostId, threadId: tap.threadId });
  if (!parsed.success) return undefined;
  return JSON.stringify(parsed.data);
}

export function decodeNotificationLink(encoded: string): NotificationTap | undefined {
  try {
    const parsed = deepLink.safeParse(JSON.parse(encoded) as unknown);
    if (!parsed.success) return undefined;
    return { hostId: parsed.data.hostId, threadId: parsed.data.threadId };
  } catch {
    return undefined;
  }
}
