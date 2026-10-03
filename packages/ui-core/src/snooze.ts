export interface SnoozePreset {
  id: "hour" | "tomorrow" | "monday";
  label: string;
  /** When it wakes, for the menu's right column. */
  detail: string;
  until: number;
}

const time = (at: Date, locale?: string) =>
  at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

function atNine(from: Date, daysAhead: number): Date {
  const next = new Date(from);
  next.setDate(next.getDate() + daysAhead);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** One hour, tomorrow 9:00 and next Monday 9:00, in local time. Pure: the caller gives now. */
export function snoozePresets(now: number, locale?: string): SnoozePreset[] {
  const today = new Date(now);
  const hour = new Date(now + 60 * 60 * 1000);
  const tomorrow = atNine(today, 1);
  // Days until the next Monday, never today: Sunday → 1, Monday → 7.
  const monday = atNine(today, (8 - today.getDay()) % 7 || 7);
  return [
    { id: "hour", label: "1 hour", detail: time(hour, locale), until: hour.getTime() },
    {
      id: "tomorrow",
      label: "Tomorrow",
      detail: time(tomorrow, locale),
      until: tomorrow.getTime(),
    },
    {
      id: "monday",
      label: "Next Monday",
      detail: monday.toLocaleDateString(locale, { month: "short", day: "numeric" }),
      until: monday.getTime(),
    },
  ];
}

/** "Tomorrow 9:00 AM", "Mon 9:00 AM", "Oct 14, 9:00 AM": when a snoozed thread wakes. */
export function describeWake(until: number, now: number, locale?: string): string {
  const at = new Date(until);
  const today = new Date(now);
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days <= 0) return time(at, locale);
  if (days === 1) return `tomorrow ${time(at, locale)}`;
  if (days < 7) return `${at.toLocaleDateString(locale, { weekday: "short" })} ${time(at, locale)}`;
  return `${at.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time(at, locale)}`;
}
