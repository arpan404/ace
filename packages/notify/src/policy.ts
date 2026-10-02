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
