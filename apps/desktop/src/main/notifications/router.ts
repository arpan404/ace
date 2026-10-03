import { CommandPayload, type Notification } from "@ace/protocol";
import type { DeepLink, DesktopSettings, NotificationCategory } from "../../shared/contract.ts";

/** Something worth telling the person about, from the daemon or derived from thread state. */
export interface Alert {
  category: NotificationCategory;
  /** Stable per occurrence; the same id twice is the same alert. */
  id: string;
  threadId?: string | undefined;
  title: string;
  body: string;
  link: DeepLink;
  /** Approve/Deny options the daemon offered for a pending approval. */
  actions?: Notification["actions"];
  interactionId?: string | undefined;
}

export type NotificationAction = "approve" | "deny" | "reply";

/** What the OS notification shows. `tag` replaces an earlier notification with the same tag. */
export interface Shown {
  tag: string;
  groupId: string;
  title: string;
  body: string;
  link: DeepLink;
  actions: { action: Exclude<NotificationAction, "reply">; label: string }[];
  reply: boolean;
  alert: Alert | undefined;
}

export type Decision =
  | { kind: "show"; notification: Shown }
  | { kind: "drop"; reason: "disabled" | "category" | "quiet" | "focused" | "duplicate" };

export interface Focus {
  windowFocused: boolean;
  /** The thread on screen, from the renderer's route. */
  threadId: string | undefined;
}

export interface RouterOptions {
  now(): number;
  /** Minutes after local midnight for a timestamp (the OS time zone). */
  minuteOfDay(at: number): number;
  /** More than this many alerts within `burstMs` collapse into one summary. */
  burstLimit?: number;
  burstMs?: number;
}

/** Map the daemon's notification statuses onto the desktop categories. */
export function alertFromDaemon(notification: Notification): Alert {
  const category: NotificationCategory =
    notification.status === "needs_you"
      ? "needsYou"
      : notification.status === "failed" || notification.status === "unresponsive"
        ? "failed"
        : "finished";
  const body =
    notification.preview ??
    (category === "needsYou"
      ? "Needs your answer"
      : category === "failed"
        ? notification.status === "unresponsive"
          ? "Stopped responding"
          : "Failed"
        : notification.backgroundCount > 0
          ? "Background work finished"
          : "Finished");
  return {
    category,
    id: notification.id,
    threadId: notification.threadId,
    title: notification.title,
    body,
    link: notification.interactionId
      ? { kind: "thread", threadId: notification.threadId, itemId: notification.interactionId }
      : { kind: "thread", threadId: notification.threadId },
    actions: notification.actions,
    interactionId: notification.interactionId,
  };
}

/**
 * Decides which alerts become OS notifications: honours the master switch, per-category
 * toggles and quiet hours; never notifies about the thread the person is looking at in a
 * focused window; groups by thread (a newer alert replaces the thread's previous one); and
 * collapses bursts across threads into one summary.
 */
export class NotificationRouter {
  private settings: DesktopSettings["notifications"];
  private focus: Focus = { windowFocused: false, threadId: undefined };
  private seen = new Set<string>();
  private recent: number[] = [];
  private options: Required<RouterOptions>;

  constructor(settings: DesktopSettings["notifications"], options: RouterOptions) {
    this.settings = settings;
    this.options = { burstLimit: 3, burstMs: 10_000, ...options };
  }

  configure(settings: DesktopSettings["notifications"]): void {
    this.settings = settings;
  }
  setFocus(focus: Focus): void {
    this.focus = focus;
  }

  route(alert: Alert): Decision {
    if (this.seen.has(alert.id)) return { kind: "drop", reason: "duplicate" };
    this.seen.add(alert.id);
    if (this.seen.size > 1_000) this.seen = new Set([...this.seen].slice(-500));
    if (!this.settings.enabled) return { kind: "drop", reason: "disabled" };
    if (this.settings.categories[alert.category] === false)
      return { kind: "drop", reason: "category" };
    const now = this.options.now();
    if (this.quiet(now)) return { kind: "drop", reason: "quiet" };
    if (this.focus.windowFocused && alert.threadId && alert.threadId === this.focus.threadId)
      return { kind: "drop", reason: "focused" };

    this.recent = this.recent.filter((at) => now - at < this.options.burstMs);
    this.recent.push(now);
    if (this.recent.length > this.options.burstLimit)
      return { kind: "show", notification: this.summary(this.recent.length) };

    const actionable = alert.category === "needsYou" && Boolean(alert.interactionId);
    return {
      kind: "show",
      notification: {
        tag: alert.threadId ? `thread:${alert.threadId}` : `alert:${alert.id}`,
        groupId: alert.threadId ?? alert.category,
        title: alert.title,
        body: alert.body,
        link: alert.link,
        actions: actionable
          ? (alert.actions ?? []).map((entry) => ({
              action: entry.action,
              label: entry.action === "approve" ? "Approve" : "Deny",
            }))
          : [],
        reply: alert.category === "needsYou" && Boolean(alert.threadId),
        alert,
      },
    };
  }

  private summary(count: number): Shown {
    return {
      tag: "summary",
      groupId: "summary",
      title: "ace",
      body: `${count} updates in the last few seconds`,
      link: { kind: "settings", page: "notifications" },
      actions: [],
      reply: false,
      alert: undefined,
    };
  }

  private quiet(at: number): boolean {
    const hours = this.settings.quietHours;
    if (!hours || hours.start === hours.end) return false;
    const minute = this.options.minuteOfDay(at);
    return hours.start < hours.end
      ? minute >= hours.start && minute < hours.end
      : minute >= hours.start || minute < hours.end;
  }
}

/**
 * The daemon command for a notification action. Ids are derived from the alert and action,
 * so a double click or a retried delivery is one command; the daemon's first-answer-wins
 * resolution settles races with other devices.
 */
export function actionCommand(
  alert: Alert,
  action: NotificationAction,
  reply?: string,
): { id: string; payload: CommandPayload } | undefined {
  const id = `notification-${alert.id}-${action}`.slice(0, 200);
  const option = (wanted: "approve" | "deny") =>
    alert.actions?.find((entry) => entry.action === wanted)?.optionId;
  if (action !== "reply") {
    const optionId = option(action);
    if (!alert.interactionId || !optionId) return undefined;
    return {
      id,
      payload: CommandPayload.parse({
        type: "interaction.resolve",
        interactionId: alert.interactionId,
        resolution: { kind: "approval", optionId },
      }),
    };
  }
  const text = reply?.trim();
  if (!text || !alert.threadId) return undefined;
  const deny = option("deny");
  // Replying to a pending approval declines it with the person's message as the reason.
  if (alert.interactionId && deny)
    return {
      id,
      payload: CommandPayload.parse({
        type: "interaction.resolve",
        interactionId: alert.interactionId,
        resolution: { kind: "approval", optionId: deny, message: text },
      }),
    };
  return {
    id,
    payload: CommandPayload.parse({
      type: "thread.send",
      threadId: alert.threadId,
      input: [{ type: "text", text }],
      delivery: "queue",
    }),
  };
}
