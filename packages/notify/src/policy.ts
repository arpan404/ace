import type { NotificationPreferences, QuietHours, ThreadStatus } from "@ace/protocol";

export function alertStatus(
  status: ThreadStatus,
): "needs_you" | "done" | "failed" | "unresponsive" | undefined {
  switch (status.state) {
    case "needs_you":
    case "done":
    case "failed":
    case "unresponsive":
      return status.state;
    default:
      return undefined;
  }
}
export function quietAt(hours: QuietHours | null, minute: number): boolean {
  if (!hours) return false;
  return hours.startMinute <= hours.endMinute
    ? hours.startMinute === hours.endMinute ||
        (minute >= hours.startMinute && minute < hours.endMinute)
    : minute >= hours.startMinute || minute < hours.endMinute;
}
export function localMinute(timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return (
    Number(parts.find((part) => part.type === "hour")?.value) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value)
  );
}
export function isQuiet(preferences: NotificationPreferences, now: number): boolean {
  return quietAt(
    preferences.quietHours,
    preferences.quietHours ? localMinute(preferences.quietHours.timeZone, now) : 0,
  );
}
/** Attempts count failed sends; jitter is injected at the I/O boundary. */
export function retryDelay(attempts: number, jitter: number): number {
  return (
    Math.min(60_000, 1000 * 2 ** (attempts - 1)) * (1 + Math.max(0, Math.min(1, jitter)) * 0.25)
  );
}
/** Failed sends retried before a job is dropped. */
export const maxRetries = 4;
/**
 * How long an alert stays deliverable to a device that is offline when it is raised: the
 * coalescing window, every retry at its longest jitter, and a second of scheduling slack.
 * A worker started after sleeping alerts only on events this recent, as a running one would.
 */
export function deliverableFor(windowMs: number): number {
  let span = windowMs + 1000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) span += retryDelay(attempt, 1);
  return span;
}
