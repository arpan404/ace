import type { Tone } from "@ace/ui-core";
import type { AutomationEntry, AutomationLists } from "@/features/automation-data/index.ts";
import {
  describeRepeat,
  describeTrigger,
  formatWhen,
} from "@/features/automation-schedule/index.ts";

/*
 * The Automations sidebar as data: which group each automation sits in, in what order, and its
 * one meta line. Pure; callers pass the time zone and `now`.
 */

export interface SidebarRow {
  id: string;
  title: string;
  /** A status the person acts on, coloured on its word only. Paused stays uncoloured. */
  status: { tone: Tone; word: string } | undefined;
  /** The rest of the meta line: when it runs next, or what starts it. */
  detail: string;
  paused: boolean;
  /** The thread an agent made it from. */
  owner: string | undefined;
}

export interface SidebarGroup {
  label: "Upcoming" | "Paused" | "In threads";
  rows: SidebarRow[];
}

function status(entry: AutomationEntry): SidebarRow["status"] {
  if (entry.lastRun?.status === "running") return { tone: "working", word: "Running" };
  if (entry.triggerError) return { tone: "failed", word: "Not watching" };
  if (entry.lastPollError) return { tone: "failed", word: "Can't check GitHub" };
  if (entry.lastRun?.status === "failed") return { tone: "failed", word: "Failed" };
  return undefined;
}

/** "Tonight 02:00 · Every day", "Running · Every 6 hours", "Paused · Fridays at 16:00". */
export function sidebarRow(entry: AutomationEntry, now: number, zone: string): SidebarRow {
  const { automation, nextRunAt } = entry;
  const trigger = automation.trigger;
  const paused = !automation.enabled;
  const shown = paused ? undefined : status(entry);
  const scheduled = trigger.kind === "schedule";
  const detail =
    scheduled && !shown && !paused && nextRunAt !== undefined
      ? `${formatWhen(nextRunAt, now, trigger.schedule.timezone || zone)} · ${describeRepeat(trigger.schedule)}`
      : describeTrigger(trigger);
  return {
    id: automation.id,
    title: automation.title,
    status: paused ? { tone: "idle", word: "Paused" } : shown,
    detail,
    paused,
    owner: entry.owner,
  };
}

const byNextRun = (a: AutomationEntry, b: AutomationEntry) =>
  (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY) ||
  a.automation.title.localeCompare(b.automation.title);

const matches = (entry: AutomationEntry, query: string) =>
  !query || entry.automation.title.toLowerCase().includes(query);

/**
 * Upcoming (enabled, soonest first), Paused, then the ones agents made in threads. Empty groups
 * are left out; a search keeps only titles that contain it.
 */
export function sidebarGroups(
  lists: AutomationLists,
  now: number,
  zone: string,
  search = "",
): SidebarGroup[] {
  const query = search.trim().toLowerCase();
  const person = lists.person.filter((entry) => matches(entry, query));
  const groups: SidebarGroup[] = [
    {
      label: "Upcoming",
      rows: person
        .filter((entry) => entry.automation.enabled)
        .toSorted(byNextRun)
        .map((entry) => sidebarRow(entry, now, zone)),
    },
    {
      label: "Paused",
      rows: person
        .filter((entry) => !entry.automation.enabled)
        .toSorted((a, b) => a.automation.title.localeCompare(b.automation.title))
        .map((entry) => sidebarRow(entry, now, zone)),
    },
    {
      label: "In threads",
      rows: lists.threads
        .filter((entry) => matches(entry, query))
        .toSorted(byNextRun)
        .map((entry) => sidebarRow(entry, now, zone)),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}
