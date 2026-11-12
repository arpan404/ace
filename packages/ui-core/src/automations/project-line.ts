import type { AutomationEntry } from "./lists.ts";
import { nextRunText } from "./sidebar-rows.ts";
import { pluralCount } from "../counts.ts";

/*
 * The project's schedules in one quiet line at the foot of a thread's Summary: "2 automations in
 * this project · next tonight 2:00 AM". Pure: the clock, the reader's zone and whether the
 * machine runs automations are passed in.
 */

/** The person's scheduled automations that run in this project, by its id or its folder. */
export function projectSchedules(
  entries: readonly AutomationEntry[],
  workspaceId: string,
  workspacePath: string | undefined,
): AutomationEntry[] {
  return entries.filter(
    ({ automation }) =>
      automation.trigger.kind === "schedule" &&
      (automation.workspace === workspaceId || automation.workspace === workspacePath),
  );
}

export interface ProjectLineFacts {
  now: number;
  /** The reader's IANA zone. */
  localZone: string;
  /** Whether the machine runs automations (`automations.enabled`); undefined while unknown. */
  running: boolean | undefined;
}

/** The line for the project's schedules; undefined when it has none. */
export function projectAutomationsLine(
  schedules: readonly AutomationEntry[],
  facts: ProjectLineFacts,
): string | undefined {
  if (!schedules.length) return undefined;
  const next = schedules
    .filter((entry) => entry.automation.enabled && entry.nextRunAt !== undefined)
    .toSorted((left, right) => (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0))[0];
  const when = next
    ? nextRunText(next.automation, next.nextRunAt, facts.now, facts.localZone, facts.running)
    : undefined;
  return [
    `${pluralCount(schedules.length, "automation")} in this project`,
    when && `next ${when.charAt(0).toLowerCase()}${when.slice(1)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the line says when the automations couldn't be read; a tap reads them again. */
export const projectAutomationsFailed = "Couldn't read automations. Try again";
