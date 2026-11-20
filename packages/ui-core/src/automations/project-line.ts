import { pluralCount } from "../counts.ts";
import type { AutomationEntry } from "./lists.ts";
import { automationsOffText, nextRunText } from "./sidebar-rows.ts";

/** The project a Summary belongs to: its id, and its folder, which older automations name. */
export interface SummaryProject {
  id: string;
  path?: string | undefined;
}

/** What the Summary's line says when the project's automations couldn't be read. */
export const projectAutomationsReadFailed = "Couldn't read automations. Try again";

/** The person's schedules that start in this project. */
export function projectSchedules(
  entries: readonly AutomationEntry[],
  project: SummaryProject,
): AutomationEntry[] {
  return entries.filter(
    ({ automation }) =>
      automation.trigger.kind === "schedule" &&
      (automation.workspace === project.id ||
        (project.path !== undefined && automation.workspace === project.path)),
  );
}

/**
 * The project's schedules as the Summary's quiet foot line: "2 automations in this project ·
 * next tonight 2:00 AM". Null when the project has none, so nothing shows.
 */
export function projectAutomationsLine(
  entries: readonly AutomationEntry[],
  facts: {
    now: number;
    localZone: string;
    /** Whether the machine runs automations; undefined while unknown. */
    running?: boolean | undefined;
  },
): string | null {
  if (entries.length === 0) return null;
  const count = `${pluralCount(entries.length, "automation")} in this project`;
  // With automations off on the machine nothing starts, so the line says that, not a "next".
  if (facts.running === false) return `${count} · ${automationsOffText}`;
  let next: AutomationEntry | undefined;
  for (const entry of entries) {
    if (!entry.automation.enabled || entry.nextRunAt === undefined) continue;
    if (!next || entry.nextRunAt < (next.nextRunAt ?? Infinity)) next = entry;
  }
  const when = next
    ? nextRunText(next.automation, next.nextRunAt, facts.now, facts.localZone, facts.running)
    : undefined;
  return when ? `${count} · next ${when.charAt(0).toLowerCase()}${when.slice(1)}` : count;
}
