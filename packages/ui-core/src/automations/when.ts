import type { AutomationTrigger } from "@ace/protocol";
import { AutomationForm, hourSteps, minuteSteps, scheduleFromForm } from "./form.ts";
import { missedRunLabels } from "./runs.ts";
import {
  describeSchedule,
  formatWhen,
  githubEventLabels,
  onceInstant,
  upcomingRuns,
  weekdayName,
  weekdays,
} from "./schedule.ts";

/*
 * What the "When it runs" controls say and offer, for every client that edits an automation's
 * trigger: the kinds, cadences and their options, each field's first problem, the one-line
 * summary and the next starts. Pure: callers pass the clock.
 */

type Trigger = AutomationForm["trigger"];
export type FieldErrors = Partial<Record<keyof AutomationForm, string>>;
export interface Choice<T extends string> {
  value: T;
  label: string;
}

export const triggerKinds: Choice<Trigger>[] = [
  { value: "schedule", label: "On a schedule" },
  { value: "github", label: "On pull requests or issues" },
  { value: "file", label: "When files change" },
  { value: "manual", label: "By hand" },
];
export const cadences: Choice<AutomationForm["cadence"]>[] = [
  { value: "minutes", label: "Minutes" },
  { value: "hourly", label: "Hours" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "once", label: "Once" },
  { value: "custom", label: "Custom" },
];
export const weekdayChoices: Choice<AutomationForm["day"]>[] = weekdays.map((value) => ({
  value,
  label: weekdayName(value),
}));
export const syntaxChoices: Choice<AutomationForm["syntax"]>[] = [
  { value: "rrule", label: "RRULE" },
  { value: "cron", label: "Cron" },
];
export const githubEventChoices: Choice<AutomationForm["event"]>[] =
  AutomationForm.shape.event.options.map((value) => ({
    value,
    label: `When ${githubEventLabels[value]}`,
  }));
export const missedRunChoices: Choice<AutomationForm["missedRun"]>[] = (
  ["run_once", "skip"] as const
).map((value) => ({ value, label: missedRunLabels[value] }));

const minutesLabel = (minutes: number) =>
  minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
const hoursLabel = (hours: number) => (hours === 1 ? "Every hour" : `Every ${hours} hours`);
/** The steps offered, with a stored value that isn't one of them kept in order. */
function stepsWith(steps: readonly number[], current: number): number[] {
  return steps.includes(current) ? [...steps] : [...steps, current].toSorted((a, b) => a - b);
}
/** "Every few minutes": each step divides an hour; a stored odd one stays listed. */
export function minuteOptions(current: number): Choice<string>[] {
  return stepsWith(minuteSteps, current).map((minutes) => ({
    value: String(minutes),
    label: minutesLabel(minutes),
  }));
}
/** "Every few hours": each step divides a day; a stored odd one stays listed. */
export function hourOptions(current: number): Choice<string>[] {
  return stepsWith(hourSteps, current).map((hours) => ({
    value: String(hours),
    label: hoursLabel(hours),
  }));
}

/** "2026-10-24": the zone's calendar date of an instant. */
export const dateIn = (at: number, timezone: string) =>
  new Date(at).toLocaleDateString("en-CA", { timeZone: timezone });

/**
 * Where a one-off run starts out: the next time `time` comes round in the zone, today if it's
 * still ahead, else tomorrow, so a new one never opens on "No upcoming run".
 */
export function nextDateFor(time: string, now: number, timezone: string): string {
  const today = dateIn(now, timezone);
  const at = onceInstant({ date: today, time }, timezone);
  return at !== undefined && at > now ? today : dateIn(now + 86_400_000, timezone);
}

/** The next quarter hour from `now` on the zone's clock, "14:15": where a new start time opens. */
export function nextQuarter(now: number, timezone: string): string {
  const quarter = 15 * 60_000;
  return new Date(Math.ceil((now + 60_000) / quarter) * quarter).toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/**
 * The patch that switches the repeat to `cadence`: each kind starts from a usable value,
 * whatever the form held before.
 */
export function cadencePatch(
  form: AutomationForm,
  cadence: AutomationForm["cadence"],
  now: number,
): Partial<AutomationForm> {
  if (cadence === "once" && !form.date)
    return { cadence, date: nextDateFor(form.time, now, form.timezone) };
  if (cadence === "minutes" && !Number.isInteger(form.minutes)) return { cadence, minutes: 15 };
  return { cadence };
}

/** What to do about a field the schema itself refuses (empty, too long), in words. */
const fieldFixes: Partial<Record<keyof AutomationForm, string>> = {
  title: "Give the automation a name, up to 256 characters.",
  prompt: "Say what the agent should do.",
  workspace: "Choose a project.",
  label: "Keep the label to 256 characters.",
};

/** Each field's first problem, by the same schema the save uses. */
export function fieldErrors(form: AutomationForm): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of AutomationForm.safeParse(form).error?.issues ?? []) {
    const field = String(issue.path[0]) as keyof AutomationForm;
    // Our own checks say what to do; a raw schema message ("expected string") never reaches people.
    errors[field] ??=
      issue.code === "custom" ? issue.message : (fieldFixes[field] ?? "Check this value.");
  }
  return errors;
}

/** Fields the When controls own: a problem in one of these opens them. */
export const whenFields = new Set<keyof AutomationForm>([
  "time",
  "every",
  "minutes",
  "date",
  "startsAt",
  "timezone",
  "expression",
  "repository",
  "label",
  "paths",
]);

export const scheduleFields: (keyof AutomationForm)[] = [
  "time",
  "every",
  "minutes",
  "date",
  "startsAt",
  "expression",
  "timezone",
];

/** The form's words for the chosen trigger: "Every day at 09:00", "When files change". */
export function whenSummary(form: AutomationForm, now: number): string {
  switch (form.trigger) {
    case "schedule": {
      const errors = fieldErrors(form);
      if (scheduleFields.some((field) => errors[field])) return "On a schedule";
      const schedule = scheduleFromForm(form, now);
      const text = describeSchedule(schedule);
      if (form.cadence === "once" || schedule.startAt <= now) return text;
      // A later start says so: "Every day at 9:00 AM from Oct 25", "Every hour from Sunday 9:00 AM".
      const timed = ["daily", "weekdays", "weekly"].includes(form.cadence);
      return `${text} from ${
        timed
          ? new Date(schedule.startAt).toLocaleDateString("en-US", {
              timeZone: schedule.timezone,
              month: "short",
              day: "numeric",
            })
          : formatWhen(schedule.startAt, now, schedule.timezone)
      }`;
    }
    case "github":
      return `When ${githubEventLabels[form.event]}`;
    case "file":
      return "When files change";
    case "manual":
      return "Only when I run it";
  }
}

/**
 * The schedule's next starts as people read them ("Tomorrow 9:00 AM"); undefined while a
 * schedule field has a problem, empty when the schedule never runs again.
 */
export function upcomingStarts(form: AutomationForm, now: number, count = 3): string[] | undefined {
  if (form.trigger !== "schedule") return undefined;
  const errors = fieldErrors(form);
  if (scheduleFields.some((field) => errors[field])) return undefined;
  return upcomingRuns(scheduleFromForm(form, now), now, count).map((at) =>
    formatWhen(at, now, form.timezone),
  );
}

/** "Next: Today 2:00 PM, Tomorrow 2:00 PM"; "No upcoming run"; empty while a field is wrong. */
export function upcomingLine(starts: readonly string[] | undefined): string {
  if (starts === undefined) return "";
  return starts.length ? `Next: ${starts.join(", ")}` : "No upcoming run";
}

/** The trigger a form starts on when the person picks its kind: GitHub opens on the project's repo. */
export function triggerPatch(
  form: AutomationForm,
  trigger: AutomationTrigger["kind"],
  suggestedRepository: string | undefined,
): Partial<AutomationForm> {
  return trigger === "github" && !form.repository && suggestedRepository
    ? { trigger, repository: suggestedRepository }
    : { trigger };
}
