import { CaretDownIcon } from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { composerStrip } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { useProjectRepository } from "./project-repository.ts";
import {
  AutomationForm,
  chosenStart,
  hourSteps,
  minuteSteps,
  scheduleFromForm,
} from "./automation-values.ts";
import { missedRunLabels } from "./labels.ts";
import {
  describeSchedule,
  formatWhen,
  onceInstant,
  githubEventLabels,
  localTimeZone,
  timeZones,
  upcomingRuns,
  weekdayName,
  weekdays,
} from "@/features/automation-schedule/index.ts";
import { dateLabel } from "@/components/ui/date-grid.ts";
import { DateTimePicker, type DateTime } from "@/components/ui/date-time-picker.tsx";
import { displayTime, TimePicker } from "@/components/ui/time-picker.tsx";
import { cityOf } from "@/components/ui/zone-search.tsx";

/*
 * When an automation runs, as the strip's first control: a list of the four kinds, then the
 * chosen kind's fields: a schedule's repeat, time, zone and missed-run rule with its next three
 * starts; a GitHub repository and event; file globs. Validated by the form's own schema.
 */

type Trigger = AutomationForm["trigger"];
export type FieldErrors = Partial<Record<keyof AutomationForm, string>>;

const kinds: { value: Trigger; label: string }[] = [
  { value: "schedule", label: "On a schedule" },
  { value: "github", label: "On pull requests or issues" },
  { value: "file", label: "When files change" },
  { value: "manual", label: "By hand" },
];
const cadences = [
  { value: "minutes", label: "Minutes" },
  { value: "hourly", label: "Hours" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "once", label: "Once" },
  { value: "custom", label: "Custom" },
] as const;
const days = weekdays.map((value) => ({ value, label: weekdayName(value) }));
const syntaxes = [
  { value: "rrule", label: "RRULE" },
  { value: "cron", label: "Cron" },
] as const;
const events = AutomationForm.shape.event.options.map((value) => ({
  value,
  label: `When ${githubEventLabels[value]}`,
}));
const missed = (["run_once", "skip"] as const).map((value) => ({
  value,
  label: missedRunLabels[value],
}));
const minutesLabel = (minutes: number) =>
  minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
function minuteOptions(current: number) {
  const steps: number[] = minuteSteps.some((step) => step === current)
    ? [...minuteSteps]
    : [...minuteSteps, current].toSorted((a, b) => a - b);
  return steps.map((minutes) => ({ value: String(minutes), label: minutesLabel(minutes) }));
}
const dateIn = (at: number, timezone: string) =>
  new Date(at).toLocaleDateString("en-CA", { timeZone: timezone });
/**
 * Where a one-off run starts out: the next time `time` comes round in the zone, today if it's
 * still ahead, else tomorrow, so a new one never opens on "No upcoming run".
 */
function nextDateFor(time: string, now: number, timezone: string): string {
  const today = dateIn(now, timezone);
  const at = onceInstant({ date: today, time }, timezone);
  return at !== undefined && at > now ? today : dateIn(now + 86_400_000, timezone);
}
/** The next quarter hour from `now` on the zone's clock, "14:15": where a new start time opens. */
function nextQuarter(now: number, timezone: string): string {
  const quarter = 15 * 60_000;
  return new Date(Math.ceil((now + 60_000) / quarter) * quarter).toLocaleTimeString("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}
/** "Oct 25, 9:30 AM", with the zone's city when it isn't this computer's. */
function momentText(moment: { date: string; time: string }, today: string, timezone: string) {
  const zone = timezone === localTimeZone() ? "" : ` · ${cityOf(timezone)}`;
  return `${dateLabel(moment.date, today)}, ${displayTime(moment.time)}${zone}`;
}
const hoursLabel = (hours: number) => (hours === 1 ? "Every hour" : `Every ${hours} hours`);
function hourOptions(current: number) {
  const steps: number[] = hourSteps.includes(current as (typeof hourSteps)[number])
    ? [...hourSteps]
    : [...hourSteps, current].toSorted((a, b) => a - b);
  return steps.map((hours) => ({ value: String(hours), label: hoursLabel(hours) }));
}

/** Each field's first problem, by the same schema the save uses. */
export function fieldErrors(form: AutomationForm): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of AutomationForm.safeParse(form).error?.issues ?? []) {
    const field = String(issue.path[0]) as keyof AutomationForm;
    // Our own checks say what to do; a raw schema message ("expected string") never reaches people.
    errors[field] ??= issue.code === "custom" ? issue.message : "Check this value.";
  }
  return errors;
}

/** Fields the When popover owns: a problem in one of these opens it. */
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

const scheduleFields: (keyof AutomationForm)[] = [
  "time",
  "every",
  "minutes",
  "date",
  "startsAt",
  "expression",
  "timezone",
];

/** The strip's words for the chosen trigger: "Every day at 09:00", "When files change". */
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

export function WhenPopover(props: {
  form: AutomationForm;
  onChange(patch: Partial<AutomationForm>): void;
  /** Problems to show: the fields the person changed, or all after a send. */
  errors: FieldErrors;
  open: boolean;
  onOpenChange(open: boolean): void;
  returnFocus(): HTMLElement | null;
}) {
  const now = useNow();
  const { form } = props;
  const summary = whenSummary(form, now);
  const suggested = useProjectRepository(form.workspace);
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger
        aria-label={`When: ${summary}`}
        className={cn(composerStrip, "max-w-64 text-foreground")}
      >
        <span className="min-w-0 truncate">{summary}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        aria-label="When it runs"
        finalFocus={props.returnFocus}
        className="flex max-h-[min(36rem,var(--available-height))] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto p-1"
      >
        <Field label="Runs">
          <Select
            label="Runs"
            value={form.trigger}
            options={kinds}
            onValueChange={(trigger) =>
              props.onChange(
                // A GitHub trigger starts from the project's own repository; the field stays editable.
                trigger === "github" && !form.repository && suggested
                  ? { trigger, repository: suggested }
                  : { trigger },
              )
            }
            className="h-7 w-full min-w-0"
          />
        </Field>
        <TriggerFields {...props} now={now} />
      </PopoverContent>
    </Popover>
  );
}

function TriggerFields(props: {
  form: AutomationForm;
  onChange(patch: Partial<AutomationForm>): void;
  errors: FieldErrors;
  now: number;
}) {
  const { form, onChange, errors } = props;
  switch (form.trigger) {
    case "schedule":
      return <ScheduleFields {...props} />;
    case "github":
      return (
        <div className="flex flex-col">
          <Field label="Repository" htmlFor="automation-repo" error={errors.repository}>
            <Input
              id="automation-repo"
              name="repository"
              value={form.repository}
              onValueChange={(repository) => onChange({ repository })}
              placeholder="owner/name"
              className="h-7 font-mono"
              aria-invalid={errors.repository ? true : undefined}
              aria-describedby={errors.repository ? "automation-repo-error" : undefined}
            />
          </Field>
          <Field label="Event">
            <Select
              label="Event"
              value={form.event}
              options={events}
              onValueChange={(event) => onChange({ event })}
              className="h-7 w-full min-w-0"
            />
          </Field>
          {form.event === "issue_labelled" && (
            <Field label="Label" htmlFor="automation-label" error={errors.label}>
              <Input
                id="automation-label"
                name="label"
                value={form.label}
                onValueChange={(label) => onChange({ label })}
                placeholder="needs-triage"
                aria-invalid={errors.label ? true : undefined}
                aria-describedby={errors.label ? "automation-label-error" : undefined}
              />
            </Field>
          )}
        </div>
      );
    case "file":
      return (
        <Field
          label="Files, one glob per line"
          htmlFor="automation-paths"
          error={errors.paths}
          stacked
        >
          <Textarea
            id="automation-paths"
            name="paths"
            value={form.paths}
            onChange={(event) => onChange({ paths: event.target.value })}
            placeholder="src/**/*.ts"
            className="min-h-20 font-mono"
            aria-invalid={errors.paths ? true : undefined}
            aria-describedby={errors.paths ? "automation-paths-error" : undefined}
          />
        </Field>
      );
    case "manual":
      return null;
  }
}

function ScheduleFields(props: {
  form: AutomationForm;
  onChange(patch: Partial<AutomationForm>): void;
  errors: FieldErrors;
  now: number;
}) {
  const { form, onChange, errors } = props;
  // This computer's zone leads the list; the rest stay in order.
  const zones = useMemo(() => {
    const local = localTimeZone();
    const all = timeZones(form.timezone);
    return all.includes(local) ? [local, ...all.filter((zone) => zone !== local)] : all;
  }, [form.timezone]);
  const timed =
    form.cadence === "daily" || form.cadence === "weekdays" || form.cadence === "weekly";
  const today = dateIn(props.now, form.timezone);
  const own = fieldErrors(form);
  const next = scheduleFields.some((field) => own[field])
    ? undefined
    : upcomingRuns(scheduleFromForm(form, props.now), props.now).map((at) =>
        formatWhen(at, props.now, form.timezone),
      );
  return (
    <div className="flex flex-col">
      <Field label="Repeat">
        <Select
          label="Repeat"
          value={form.cadence}
          options={cadences}
          onValueChange={(cadence) =>
            onChange(
              // Each kind starts from a usable value, whatever the form held before.
              cadence === "once" && !form.date
                ? { cadence, date: nextDateFor(form.time, props.now, form.timezone) }
                : cadence === "minutes" && !Number.isInteger(form.minutes)
                  ? { cadence, minutes: 15 }
                  : { cadence },
            )
          }
          className="h-7 w-full min-w-0"
        />
      </Field>
      {form.cadence === "weekly" && (
        <Field label="Day">
          <Select
            label="Day"
            value={form.day}
            options={days}
            onValueChange={(day) => onChange({ day })}
            className="h-7 w-full min-w-0"
          />
        </Field>
      )}
      {form.cadence === "minutes" && (
        <Field label="How often" error={errors.minutes}>
          <Select
            label="How often"
            value={String(form.minutes)}
            options={minuteOptions(form.minutes)}
            onValueChange={(minutes) => onChange({ minutes: Number(minutes) })}
            className="h-7 w-full min-w-0"
          />
        </Field>
      )}
      {form.cadence === "once" && (
        <Field
          label="At"
          htmlFor="automation-date"
          error={errors.date ?? errors.time ?? errors.timezone}
        >
          <DateTimePicker
            id="automation-date"
            label="Runs at"
            value={{ date: form.date, time: form.time, timezone: form.timezone }}
            text={form.date ? momentText(form, today, form.timezone) : "Pick a date"}
            today={today}
            min={today}
            zones={zones}
            onChange={(patch) => onChange(patch)}
            className="h-7 w-full min-w-0"
            aria-invalid={errors.date || errors.time ? true : undefined}
            aria-describedby={errors.date ? "automation-date-error" : undefined}
          />
        </Field>
      )}
      {timed && (
        <Field label="At" htmlFor="automation-time" error={errors.time}>
          <TimePicker
            id="automation-time"
            label="At"
            value={form.time}
            onValueChange={(time) => onChange({ time })}
            className="h-7 w-full min-w-0"
            aria-invalid={errors.time ? true : undefined}
            aria-describedby={errors.time ? "automation-time-error" : undefined}
          />
        </Field>
      )}
      {form.cadence === "hourly" && (
        <Field label="How often" error={errors.every}>
          <Select
            label="How often"
            value={String(form.every)}
            options={hourOptions(form.every)}
            onValueChange={(every) => onChange({ every: Number(every) })}
            className="h-7 w-full min-w-0"
          />
        </Field>
      )}
      {form.cadence === "custom" && (
        <>
          <Field label="Syntax">
            <SegmentedControl
              label="Syntax"
              value={form.syntax}
              options={syntaxes}
              onValueChange={(syntax) => onChange({ syntax })}
            />
          </Field>
          <Field
            label="Expression"
            htmlFor="automation-expression"
            error={errors.expression}
            stacked
          >
            <Input
              id="automation-expression"
              name="expression"
              value={form.expression}
              onValueChange={(expression) => onChange({ expression })}
              placeholder={
                form.syntax === "cron" ? "30 7 * * 1-5" : "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9"
              }
              className="font-mono"
              aria-invalid={errors.expression ? true : undefined}
              aria-describedby={errors.expression ? "automation-expression-error" : undefined}
            />
          </Field>
        </>
      )}
      {form.cadence !== "once" && (
        <StartsField
          form={form}
          onChange={onChange}
          error={errors.startsAt ?? errors.timezone}
          now={props.now}
          today={today}
          zones={zones}
        />
      )}
      <Field label="If missed">
        <Select
          label="If a run is missed"
          value={form.missedRun}
          options={missed}
          onValueChange={(missedRun) => onChange({ missedRun })}
          className="h-7 w-full min-w-0"
        />
      </Field>
      <p aria-live="polite" className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
        {next === undefined ? "" : next.length ? `Next: ${next.join(", ")}` : "No upcoming run"}
      </p>
    </div>
  );
}

/**
 * When a repeating schedule begins: "Now" until a later moment is picked in its panel, which also
 * holds the zone every time in the schedule is read in.
 */
function StartsField(props: {
  form: AutomationForm;
  onChange(patch: Partial<AutomationForm>): void;
  error: string | undefined;
  now: number;
  today: string;
  zones: readonly string[];
}) {
  const { form, today } = props;
  const [date = "", time = nextQuarter(props.now, form.timezone)] = form.startsAt.split("T");
  const start = chosenStart(form);
  const later = start !== undefined && start > props.now;
  const change = (patch: Partial<DateTime>) => {
    const { timezone, ...moment } = patch;
    const next = { date: date || today, time, ...moment };
    props.onChange({
      ...(timezone ? { timezone } : {}),
      // A zone alone keeps "now" as now; a day or a time picks a moment.
      ...(moment.date || moment.time || date ? { startsAt: `${next.date}T${next.time}` } : {}),
    });
  };
  return (
    <Field label="Starts" htmlFor="automation-starts" error={props.error}>
      <DateTimePicker
        id="automation-starts"
        label="Starts"
        value={{ date: later ? date : "", time, timezone: form.timezone }}
        text={
          later
            ? momentText({ date, time }, today, form.timezone)
            : form.timezone === localTimeZone()
              ? "Now"
              : `Now · ${cityOf(form.timezone)}`
        }
        today={today}
        min={today}
        zones={props.zones}
        onChange={change}
        clearLabel="Start now"
        onClear={() => props.onChange({ startsAt: "" })}
        className="h-7 w-full min-w-0"
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? "automation-starts-error" : undefined}
      />
    </Field>
  );
}

/** A label on the left and its control on the right, with the control's problem under it. */
function Field(props: {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  stacked?: boolean;
  children: ReactNode;
}) {
  const errorId = props.htmlFor ? `${props.htmlFor}-error` : undefined;
  return (
    <div className="flex flex-col gap-1 px-2 py-0.5">
      <div className={cn("flex gap-3", props.stacked ? "flex-col gap-1" : "items-center")}>
        <label htmlFor={props.htmlFor} className="w-18 shrink-0 text-ui text-muted-foreground">
          {props.label}
        </label>
        <div className={props.stacked ? "w-full" : "min-w-0 flex-1"}>{props.children}</div>
      </div>
      {props.error && (
        <p id={errorId} className="text-xs text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
