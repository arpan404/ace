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

/*
 * Building an `Intl.DateTimeFormat` costs far more than formatting with one (about 170 µs
 * against 30 µs in V8, 44 µs against 1 µs in JavaScriptCore), and a transcript formats a clock
 * for every message row it mounts, so clock formatters are kept. A kept formatter must print
 * exactly what a fresh one would, through a change of zone or locale mid-session:
 *
 * - Zone. These clocks print no zone name, so in the host's zone the text for an instant depends
 *   only on the host's UTC offset at that instant, which `getTimezoneOffset` reads afresh and
 *   cheaply. That wall time is formatted in UTC: one formatter serves every host zone, and two
 *   zones print the same text exactly when their offsets at that instant agree. An explicit zone
 *   keeps its own formatter, keyed by name.
 * - Locale. Every call is keyed by the host's formatting defaults, read afresh: the default
 *   locale (as `Intl.ListFormat` resolves it, about 1 µs; `Intl.DateTimeFormat` costs as much as
 *   the formatter saved in V8) and the default time and date text of a fixed instant. That text
 *   shows what the locale tag can leave out (hour cycle, digits, day-period words, the region's
 *   date order), including preferences an engine applies beyond the tag, and both follow the
 *   host's own setting changes. A call naming its locale is keyed by that name too.
 */
const probe = new Date(Date.UTC(2026, 0, 15, 13, 5, 9));
const hostDefaults = () =>
  `${new Intl.ListFormat().resolvedOptions().locale}\u0000${probe.toLocaleTimeString()}\u0000${probe.toLocaleDateString()}`;
const formatters = new Map<string, Intl.DateTimeFormat>();
/** Locales and zones a session formats in are few; past this, start again rather than grow. */
const formatterLimit = 32;
const minute = 60_000;

function clockText(
  kind: string,
  at: number,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormatPart[] {
  const zone = timeZone ?? "UTC";
  const key = `${kind}\u0000${zone}\u0000${locale ?? ""}\u0000${hostDefaults()}`;
  let found = formatters.get(key);
  if (!found) {
    if (formatters.size >= formatterLimit) formatters.clear();
    found = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
    formatters.set(key, found);
  }
  // The host's wall time at `at`, as a UTC instant: what the host zone would print.
  const instant = timeZone === undefined ? at - new Date(at).getTimezoneOffset() * minute : at;
  return found.formatToParts(instant);
}

/** "14:02" in the reader's locale. */
export function formatClock(at: number, locale?: string, timeZone?: string): string {
  return clockText("clock", at, locale, { hour: "numeric", minute: "2-digit" }, timeZone)
    .map((part) => (part.type === "dayPeriod" ? part.value.toUpperCase() : part.value))
    .join("")
    .replace(/[\u202f\u00a0]/g, " ");
}

/** A bounded clock for row statuses: "14:02", without a day period or date. */
export function formatShortClock(at: number, locale?: string): string {
  const parts = clockText(
    "short",
    at,
    locale,
    { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    undefined,
  );
  return parts.map((part) => part.value).join("");
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
