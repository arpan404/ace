import { formatAge } from "./time.ts";

/*
 * History: every settled thread at rest, newest first, grouped by how long ago it last worked.
 * The rows themselves come from the loaded list and the daemon's search; this only filters and
 * groups them. Pure: the caller passes the clock.
 */

/** A settled thread History lists: when it last worked and its project. */
export interface HistoryItem {
  id: string;
  at: number;
  project: string;
}

export type HistoryGroup = "week" | "last-week" | "earlier";

export const historyGroupLabels: Record<HistoryGroup, string> = {
  week: "This week",
  "last-week": "Last week",
  earlier: "Earlier",
};

const dayMs = 24 * 60 * 60 * 1000;

/** Which group a thread that last worked at `at` falls in: the past 7 days, the 7 before, older. */
export function historyGroupOf(at: number, now: number): HistoryGroup {
  const age = now - at;
  if (age < 7 * dayMs) return "week";
  return age < 14 * dayMs ? "last-week" : "earlier";
}

export interface HistorySection {
  group: HistoryGroup;
  label: string;
  items: HistoryItem[];
}

/**
 * History's sections for one project filter (null: every project), newest first, each id once
 * (a loaded thread and the daemon's hit for it are one row).
 */
export function historySections(
  items: readonly HistoryItem[],
  input: { project: string | null; now: number },
): HistorySection[] {
  const seen = new Set<string>();
  const sections: HistorySection[] = [];
  const shown = items
    .filter((item) => input.project === null || item.project === input.project)
    .toSorted((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  for (const item of shown) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const group = historyGroupOf(item.at, input.now);
    const last = sections.at(-1);
    if (last?.group === group) last.items.push(item);
    else sections.push({ group, label: historyGroupLabels[group], items: [item] });
  }
  return sections;
}

/** A History row's date: its age within the past week ("3h", "5d"), else the day ("Oct 24"). */
export function historyDate(at: number, now: number, locale?: string): string {
  if (now - at < 7 * dayMs) return formatAge(at, now);
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
