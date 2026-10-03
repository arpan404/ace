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

/** 9_214_000 → "9.2M", 840_000 → "840K". */
export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD, `days` before `now`. */
export function isoDay(now: number, days = 0): string {
  const date = new Date(now - days * 24 * hour);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
