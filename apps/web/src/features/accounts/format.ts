const hour = 3_600_000;

/** "Resets 15:20" within a day, "Resets Monday" within a week, else the date. */
export function formatResets(at: number, now: number, locale?: string): string {
  if (at - now < 20 * hour)
    return `Resets ${new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(at)}`;
  if (at - now < 7 * 24 * hour)
    return `Resets ${new Intl.DateTimeFormat(locale, { weekday: "long" }).format(at)}`;
  return `Resets ${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at)}`;
}

/** The clock time only: "16:47". */
export function formatClock(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}
