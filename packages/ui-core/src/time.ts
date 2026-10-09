/*
 * Relative and elapsed time, as every list and log line shows it. Pure: callers pass `now`, so
 * web and mobile share one wording and tests never read the clock.
 */

/** "now", "2m", "3h", "4d", "6w": the compact ages in lists. */
export function formatAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** "just now", "2m ago", "3h ago": an age in a sentence ("Started 2m ago"). */
export function formatAgo(at: number, now: number): string {
  const age = formatAge(at, now);
  return age === "now" ? "just now" : `${age} ago`;
}

/** "38s", "4m 12s", "1h 2m": how long a turn or task has been going, to the second. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "0.4s", "4.2s", "12s", "1m 3s": a short job's duration, to a tenth of a second under ten. */
export function formatDuration(ms: number): string {
  if (ms < 9_950) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

/** "42s", "6m", "1h 12m": how long something ran between two moments, to the minute. */
export function formatSpan(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** "14:02" in the reader's locale. */
export function formatClock(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone })
    .formatToParts(at)
    .map((part) => (part.type === "dayPeriod" ? part.value.toUpperCase() : part.value))
    .join("")
    .replace(/[\u202f\u00a0]/g, " ");
}

/** "under a minute", "12m", "1h 27m", "3d 4h": the time left until a reset, rounded up. */
export function formatCountdown(ms: number): string {
  const minutes = Math.ceil(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
