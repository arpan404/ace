/*
 * The words a milestone carries besides its title, wherever one is picked: the web's new pull
 * request page and the phone's. Pure.
 */

/**
 * "Due Nov 20, 2026", or null with no due date. GitHub keeps a due date as midnight UTC, so the
 * day is read in UTC: elsewhere it would show the day before.
 */
export function milestoneDue(dueOn: string | null, locale?: string): string | null {
  if (!dueOn) return null;
  const at = Date.parse(dueOn);
  if (Number.isNaN(at)) return null;
  const day = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  return `Due ${day}`;
}
