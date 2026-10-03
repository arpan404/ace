/** All times are epoch milliseconds. Provider epoch seconds are decoded at ingress. */
function civil(epoch: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epoch);
  const value = (key: string) => Number(parts.find((p) => p.type === key)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}
export function parseLimitReset(message: string, now: number, timeZone: string): number | null {
  const iso =
    /(?:try again|resets?|until).*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))/i.exec(
      message,
    )?.[1];
  if (iso) {
    const instant = Date.parse(iso);
    return Number.isFinite(instant) && instant > now ? instant : null;
  }
  const match = /(?:try again at|resets?(?: at)?|until)\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i.exec(
    message,
  );
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const wantedHour = (hour % 12) + (match[3]?.toUpperCase() === "PM" ? 12 : 0);
  const zone = /\(([A-Za-z_]+\/[A-Za-z_/]+)\)/.exec(message)?.[1] ?? timeZone;
  try {
    const local = civil(now, zone);
    const midnight = Date.UTC(local.year, local.month - 1, local.day);
    for (let day = 0; day < 3; day++) {
      const date = new Date(midnight + day * 86_400_000);
      const target = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        wantedHour,
        minute,
      );
      const offsets = new Set<number>();
      for (let h = -24; h <= 24; h += 6) {
        const sample = target + h * 3_600_000;
        const c = civil(sample, zone);
        offsets.add(Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - sample);
      }
      const candidates: number[] = [];
      for (const offset of offsets) {
        const candidate = target - offset;
        const c = civil(candidate, zone);
        if (
          c.year === date.getUTCFullYear() &&
          c.month === date.getUTCMonth() + 1 &&
          c.day === date.getUTCDate() &&
          c.hour === wantedHour &&
          c.minute === minute
        )
          candidates.push(candidate);
      }
      // Do not guess across DST folds or a missing local clock time today.
      if (candidates.length !== 1) return null;
      const candidate = candidates[0];
      if (candidate !== undefined && candidate > now) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}
