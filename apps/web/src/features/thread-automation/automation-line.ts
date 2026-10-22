import { formatAgo } from "@ace/ui-core";
import {
  dayOf,
  describeTrigger,
  describeWhen,
  formatWhen,
} from "@/features/automation-schedule/index.ts";
import type { ThreadAutomation } from "./thread-automations-source.ts";

/** Mid-sentence, "Tonight" reads "tonight"; weekday and month names keep their capital. */
const midSentence = (words: string) =>
  words.replace(/^(Today|Tonight|Tomorrow|Yesterday)\b/, (day) => day.toLowerCase());
const lowerFirst = (words: string) => words.charAt(0).toLowerCase() + words.slice(1);

/*
 * The one sentence a thread's automations put above its composer, when nothing more urgent is
 * there: "Daily check · runs every day at 2:00 AM · next tonight · Pause · Open", "Running Daily
 * check · started 2m ago · Open run", "Paused · Daily check · runs every day at 2:00 AM · Resume",
 * "Not watching Docs sync · ~/code/relay is gone · Open", "2 automations · next tonight 2:00 AM · Open". Pure: the clock
 * and the reader's zone are passed in.
 */

export type LineTone = "working" | "failed";

/** One stretch between the "·"s: a status word in its colour, then plain words. */
export interface LineSegment {
  status?: { word: string; tone: LineTone };
  text?: string;
}

export type LineAction =
  | { kind: "pause"; id: string; revision: number | undefined }
  | { kind: "resume"; id: string; revision: number | undefined }
  /** The automation's page; without an id, the automations list. */
  | { kind: "open"; automationId: string | undefined }
  /** The thread a run is working in. */
  | { kind: "open-run"; threadId: string };

export interface AutomationLine {
  segments: readonly LineSegment[];
  actions: readonly LineAction[];
}

export interface LineFacts {
  now: number;
  /** The reader's IANA zone; a schedule kept in another one names it. */
  localZone: string;
}

const actionLabels: Record<LineAction["kind"], string> = {
  pause: "Pause",
  resume: "Resume",
  open: "Open",
  "open-run": "Open run",
};
export const actionLabel = (action: LineAction) => actionLabels[action.kind];

/** The whole line as read aloud, and as tests read it. */
export function lineText(line: AutomationLine): string {
  const segments = line.segments.map((segment) =>
    [segment.status?.word, segment.text].filter(Boolean).join(" "),
  );
  return [...segments, ...line.actions.map(actionLabel)].join(" · ");
}

const zoneOf = (entry: ThreadAutomation, facts: LineFacts) =>
  entry.automation.trigger.kind === "schedule"
    ? entry.automation.trigger.schedule.timezone
    : facts.localZone;

/** After "runs": "every day at 2:00 AM", with the schedule's zone when it isn't the reader's. */
function runsWords(entry: ThreadAutomation, facts: LineFacts): string {
  const { trigger } = entry.automation;
  return trigger.kind === "manual"
    ? "only when started by hand"
    : lowerFirst(describeWhen(trigger, facts.localZone));
}

/** The daemon's reason as a clause: its first line, without a closing full stop. */
const reason = (message: string) =>
  (message.split("\n")[0] ?? "").trim().replace(/\.$/, "") || "its trigger failed";

const notWatching = (entry: ThreadAutomation) =>
  entry.automation.trigger.kind === "file" || entry.automation.trigger.kind === "github"
    ? "Not watching"
    : "Not scheduled";

function single(entry: ThreadAutomation, facts: LineFacts): AutomationLine {
  const { automation, lastRun } = entry;
  const open: LineAction = { kind: "open", automationId: automation.id };
  if (lastRun?.status === "running" || lastRun?.status === "queued")
    return {
      segments: [
        { status: { word: "Running", tone: "working" }, text: automation.title },
        { text: `started ${formatAgo(lastRun.startedAt, facts.now)}` },
      ],
      actions: [lastRun.threadId ? { kind: "open-run", threadId: lastRun.threadId } : open],
    };
  if (!automation.enabled)
    return {
      segments: [
        { text: "Paused" },
        { text: automation.title },
        { text: `runs ${runsWords(entry, facts)}` },
      ],
      actions: [{ kind: "resume", id: automation.id, revision: entry.revision }],
    };
  if (entry.triggerError)
    return {
      segments: [
        { status: { word: notWatching(entry), tone: "failed" }, text: automation.title },
        { text: reason(entry.triggerError.message) },
      ],
      actions: [open],
    };
  // The name first: a thread may own several, and "runs by hand" alone says nothing.
  const segments: LineSegment[] = [
    { text: automation.title },
    { text: `runs ${runsWords(entry, facts)}` },
  ];
  if (entry.nextRunAt !== undefined) {
    const zone = zoneOf(entry, facts);
    const { trigger } = automation;
    // "Runs every day at 2:00 AM · next tonight": the time is said once.
    const when =
      trigger.kind === "schedule" && / at /.test(describeTrigger(trigger))
        ? midSentence(dayOf(entry.nextRunAt, facts.now, zone))
        : midSentence(formatWhen(entry.nextRunAt, facts.now, zone));
    segments.push({ text: `next ${when}` });
  }
  // Something that only runs by hand has nothing to pause.
  const pause: LineAction[] =
    automation.trigger.kind === "manual"
      ? []
      : [{ kind: "pause", id: automation.id, revision: entry.revision }];
  return { segments, actions: [...pause, open] };
}

function several(entries: readonly ThreadAutomation[], facts: LineFacts): AutomationLine {
  const segments: LineSegment[] = [{ text: `${entries.length} automations` }];
  const running = entries.filter(
    (entry) => entry.lastRun?.status === "running" || entry.lastRun?.status === "queued",
  ).length;
  if (running) segments.push({ status: { word: `${running} running`, tone: "working" } });
  const failing = entries.filter((entry) => entry.automation.enabled && entry.triggerError).length;
  if (failing) segments.push({ status: { word: `${failing} not watching`, tone: "failed" } });
  const soonest = entries
    .filter((entry) => entry.automation.enabled && entry.nextRunAt !== undefined)
    .toSorted((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  if (soonest?.nextRunAt !== undefined)
    segments.push({
      text: `next ${midSentence(formatWhen(soonest.nextRunAt, facts.now, zoneOf(soonest, facts)))}`,
    });
  return { segments, actions: [{ kind: "open", automationId: undefined }] };
}

/** The line for a thread's automations; nothing when it has none. */
export function automationLine(
  entries: readonly ThreadAutomation[],
  facts: LineFacts,
): AutomationLine | undefined {
  const [first] = entries;
  if (!first) return undefined;
  return entries.length === 1 ? single(first, facts) : several(entries, facts);
}
