/*
 * When a schedule phrase next fires, for the New routine page's one-line preview. It reads the
 * phrases Spade documents most (spade/docs/routines.md): `daily at 9:00`, `weekdays at 9am`,
 * `mondays and thursdays at 6:30pm`, `at 7:00 and 19:00`, `every 2 hours`, `every 30 minutes`.
 * Anything else (cron, odd phrasing) gives nothing: Spade reads it when the routine is created,
 * and says why in words if it can't.
 */

const minute = 60_000;

const dayWords: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** `9:00`, `9am`, `6:30pm`, `noon`: minutes after midnight, or undefined. */
function clockOf(text: string): number | undefined {
  const word = text.trim();
  if (word === "noon") return 12 * 60;
  if (word === "midnight") return 0;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(word);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const mins = Number(match[2] ?? "0");
  if (mins > 59) return undefined;
  if (match[3]) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
  } else if (hour > 23) return undefined;
  return hour * 60 + mins;
}

/** Which weekdays (0 = Sunday) the words before `at` name; every day when they name none. */
function daysOf(words: string): Set<number> | undefined {
  const text = words.trim();
  if (text === "" || text === "daily" || text === "every day")
    return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (text === "weekdays") return new Set([1, 2, 3, 4, 5]);
  if (text === "weekends") return new Set([0, 6]);
  const days = new Set<number>();
  for (const word of text.split(/,|\band\b/)) {
    const day =
      dayWords[
        word
          .trim()
          .replace(/^every\s+/, "")
          .slice(0, 3)
      ];
    if (day === undefined || !/^[a-z]+s?$/.test(word.trim().replace(/^every\s+/, "")))
      return undefined;
    days.add(day);
  }
  return days.size > 0 ? days : undefined;
}

/** The next time `phrase` fires after `now` (ms), in the person's own zone, or undefined. */
export function nextRunOf(phrase: string, now: number): number | undefined {
  const text = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  const every = /^every (\d+ )?(minute|minutes|hour|hours)$/.exec(text);
  if (every) {
    const count = every[1] ? Number(every[1]) : 1;
    const step = count * (every[2]?.startsWith("hour") ? 60 : 1) * minute;
    // Intervals count real time from the epoch, as Spade counts them.
    return count > 0 ? (Math.floor(now / step) + 1) * step : undefined;
  }
  const at = /^(.*?)\s*\bat (.+)$/.exec(text);
  if (!at) return undefined;
  const days = daysOf(at[1] ?? "");
  const clocks = (at[2] ?? "").split(/,|\band\b/).map(clockOf);
  if (!days || clocks.length === 0 || clocks.some((each) => each === undefined)) return undefined;
  const times = (clocks as number[]).toSorted((a, b) => a - b);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + offset);
    if (!days.has(day.getDay())) continue;
    for (const time of times) {
      const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, time).getTime();
      if (slot > now) return slot;
    }
  }
  return undefined;
}

/** The quick choices under the schedule field: what the chip says, and the phrase it writes. */
export const routineChips: readonly { label: string; schedule: string }[] = [
  { label: "Every morning", schedule: "daily at 9:00" },
  { label: "Weekdays at 9", schedule: "weekdays at 9:00" },
  { label: "Every hour", schedule: "every hour" },
  { label: "Weekly", schedule: "mondays at 9:00" },
];

/** A routine's name from what it does: its first line, cut at a word, 60 characters at most. */
export function routineNameOf(instruction: string): string {
  const line = (instruction.trim().split("\n")[0] ?? "").trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24)).trim()}…`;
}
