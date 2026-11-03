/*
 * Profile's numbers from a year of daily token totals: the headline stats, the activity grid
 * (one column per week, Sunday first) and its month labels. Pure: days are YYYY-MM-DD strings
 * in the person's usage time zone, and "today" is passed in.
 */

export interface DayTokens {
  day: string;
  tokens: number;
}

export interface ActivityCell {
  day: string;
  tokens: number;
  /** 0 for no work; 1–4 by quartile among the days that had work. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Before the year's first day or after today: drawn as a gap. */
  outside: boolean;
}

export interface ProfileStats {
  total: number;
  peak: DayTokens | undefined;
  activeDays: number;
  longestStreak: number;
  /** Days in a row with work, up to today (or yesterday, while today has none yet). */
  currentStreak: number;
  weeks: ActivityCell[][];
  /** A month's short name over the week its first day falls in. */
  months: { label: string; week: number }[];
}

const DAY_MS = 86_400_000;
const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The day `count` days before `day`. */
export function daysBefore(day: string, count: number): string {
  return toDay(toTime(day) - count * DAY_MS);
}

/** Thresholds splitting the days with work into four equal groups. */
function quartiles(values: number[]): [number, number, number] {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
  return [at(0.25), at(0.5), at(0.75)];
}

function levelOf(tokens: number, cuts: [number, number, number]): ActivityCell["level"] {
  if (tokens <= 0) return 0;
  if (tokens <= cuts[0]) return 1;
  if (tokens <= cuts[1]) return 2;
  if (tokens <= cuts[2]) return 3;
  return 4;
}

/** The stats and grid for the `span` days ending on `today`. */
export function profileStats(days: readonly DayTokens[], today: string, span = 365): ProfileStats {
  const from = daysBefore(today, span - 1);
  const byDay = new Map<string, number>();
  for (const { day, tokens } of days)
    if (day >= from && day <= today && tokens > 0) byDay.set(day, (byDay.get(day) ?? 0) + tokens);

  let total = 0;
  let peak: DayTokens | undefined;
  for (const [day, tokens] of byDay) {
    total += tokens;
    if (!peak || tokens > peak.tokens) peak = { day, tokens };
  }

  let longestStreak = 0;
  let run = 0;
  for (let time = toTime(from); time <= toTime(today); time += DAY_MS) {
    run = byDay.has(toDay(time)) ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  let currentStreak = 0;
  let cursor = byDay.has(today) ? today : daysBefore(today, 1);
  while (cursor >= from && byDay.has(cursor)) {
    currentStreak += 1;
    cursor = daysBefore(cursor, 1);
  }

  const cuts = quartiles([...byDay.values()]);
  const start = toTime(from) - new Date(toTime(from)).getUTCDay() * DAY_MS;
  const end = toTime(today) + (6 - new Date(toTime(today)).getUTCDay()) * DAY_MS;
  const weeks: ActivityCell[][] = [];
  const months: ProfileStats["months"] = [];
  for (let weekStart = start; weekStart <= end; weekStart += 7 * DAY_MS) {
    const week: ActivityCell[] = [];
    for (let offset = 0; offset < 7; offset++) {
      const day = toDay(weekStart + offset * DAY_MS);
      const tokens = byDay.get(day) ?? 0;
      const outside = day < from || day > today;
      week.push({ day, tokens, level: outside ? 0 : levelOf(tokens, cuts), outside });
      // A month is labelled over the week its first day falls in, or the first week shown.
      const date = new Date(weekStart + offset * DAY_MS);
      if (!outside && (date.getUTCDate() === 1 || day === from)) {
        const label = monthNames[date.getUTCMonth()] ?? "";
        const last = months.at(-1);
        if (last?.week === weeks.length) last.label = label;
        else months.push({ label, week: weeks.length });
      }
    }
    weeks.push(week);
  }
  // A label squeezed against the next one (the first, partial month) is dropped.
  const spaced = months.filter((month, index) => {
    const next = months[index + 1];
    return !next || next.week - month.week >= 3;
  });

  return {
    total,
    peak,
    activeDays: byDay.size,
    longestStreak,
    currentStreak,
    weeks,
    months: spaced,
  };
}

export interface Share {
  key: string;
  tokens: number;
  /** Whole percent of the total, at least 1 for anything above zero. */
  percent: number;
}

/** Rows ranked by tokens with each one's share of the total, largest first. */
export function shares(rows: readonly { key: string; tokens: number }[], limit: number): Share[] {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  if (total <= 0) return [];
  return rows
    .filter((row) => row.tokens > 0)
    .toSorted((a, b) => b.tokens - a.tokens)
    .slice(0, limit)
    .map((row) => ({
      ...row,
      percent: Math.max(1, Math.round((row.tokens / total) * 100)),
    }));
}
