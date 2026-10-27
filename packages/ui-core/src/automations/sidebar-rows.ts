import type { Automation } from "@ace/protocol";
import type { Tone } from "../status.ts";
import type { AutomationEntry, AutomationLists } from "./lists.ts";
import { describeRepeat, formatNextRun, formatWhen } from "./schedule.ts";
import { scheduleState, scheduleStateCopy } from "./trigger-health.ts";

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
  if (entry.lastRun?.status === "running" || entry.lastRun?.status === "queued")
    return { tone: "working", word: "Running" };
  if (entry.triggerError) return { tone: "failed", word: "Not watching" };
  if (entry.lastPollError) return { tone: "failed", word: "Can't check GitHub" };
  if (entry.lastRun?.status === "failed") return { tone: "failed", word: "Failed" };
  return undefined;
}

/** What starts it, in a few words that fit a sidebar row. */
function shortTrigger(trigger: AutomationEntry["automation"]["trigger"]): string {
  switch (trigger.kind) {
    case "manual":
      return "By hand";
    case "schedule":
      return describeRepeat(trigger.schedule);
    case "file":
      return "When files change";
    case "github":
      return {
        pr_changed: "On pull requests",
        ci_failed: "When CI fails",
        review_comment: "On review comments",
        issue_labelled: "On labelled issues",
      }[trigger.event];
  }
}

/** "Tonight 2:00 AM · Every day", "Running · Every 6 hours", "Paused · Fridays", "On pull requests". */
export function sidebarRow(entry: AutomationEntry, now: number, zone: string): SidebarRow {
  const { automation, nextRunAt } = entry;
  const trigger = automation.trigger;
  const paused = !automation.enabled;
  const shown = paused ? undefined : status(entry);
  const scheduled = trigger.kind === "schedule";
  const detail =
    scheduled && !shown && !paused && nextRunAt !== undefined
      ? `${formatWhen(nextRunAt, now, trigger.schedule.timezone || zone)} · ${describeRepeat(trigger.schedule)}`
      : shortTrigger(trigger);
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

/**
 * When it runs next, in words: paused, the next start (with its zone when not local), or what
 * it waits for. A spent schedule says it is finished; one the daemon hasn't placed yet says
 * that, not a guess. Automations being off on the machine is the caller's to say.
 */
export function nextRunText(
  automation: Automation,
  nextRunAt: number | undefined,
  now: number,
  localZone: string,
): string {
  if (!automation.enabled) return "Paused. Resume to schedule the next run.";
  if (nextRunAt !== undefined) {
    const zone =
      automation.trigger.kind === "schedule" ? automation.trigger.schedule.timezone : undefined;
    const when = formatNextRun(nextRunAt, now, zone);
    return zone && zone !== localZone ? `${when} (${zone})` : when;
  }
  switch (automation.trigger.kind) {
    case "github":
      return "On the next matching event";
    case "file":
      return "On the next change";
    case "manual":
      return "Only when you run it";
    case "schedule": {
      const state = scheduleState(automation.trigger.schedule, undefined, now);
      return state === "exhausted" ? scheduleStateCopy(state) : "Not scheduled yet";
    }
  }
}
