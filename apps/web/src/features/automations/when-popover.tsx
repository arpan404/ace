import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
import { Input, Textarea } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { composerStrip } from "@/features/thread/index.ts";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { AutomationForm, hourSteps, scheduleFromForm } from "./automation-values.ts";
import { missedRunLabels } from "./labels.ts";
import {
  describeSchedule,
  formatRunInZone,
  githubEventLabels,
  timeZones,
  upcomingRuns,
  weekdayName,
  weekdays,
} from "@/features/automation-schedule/index.ts";
import { TimeInput } from "./time-input.tsx";

/*
 * When an automation runs, as the strip's first control: a list of the four kinds, then the
 * chosen kind's fields: a schedule's repeat, time, zone and missed-run rule with its next three
 * starts; a GitHub repository and event; file globs. Validated by the form's own schema.
 */

type Trigger = AutomationForm["trigger"];
export type FieldErrors = Partial<Record<keyof AutomationForm, string>>;

const kinds: { value: Trigger; label: string }[] = [
  { value: "schedule", label: "On a schedule" },
  { value: "github", label: "When a pull request or issue changes" },
  { value: "file", label: "When files change" },
  { value: "manual", label: "Only when I run it" },
];
const cadences = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Once a week" },
  { value: "hourly", label: "Every few hours" },
  { value: "custom", label: "Custom (RRULE or cron)" },
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
    errors[field] ??= issue.message;
  }
  return errors;
}

/** Fields the When popover owns: a problem in one of these opens it. */
export const whenFields = new Set<keyof AutomationForm>([
  "time",
  "every",
  "timezone",
  "expression",
  "repository",
  "label",
  "paths",
]);

const scheduleFields: (keyof AutomationForm)[] = ["time", "every", "expression", "timezone"];

/** The strip's words for the chosen trigger: "Every day at 09:00", "When files change". */
export function whenSummary(form: AutomationForm, now: number): string {
  switch (form.trigger) {
    case "schedule": {
      const errors = fieldErrors(form);
      return scheduleFields.some((field) => errors[field])
        ? "On a schedule"
        : describeSchedule(scheduleFromForm(form, now));
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
        className="flex max-h-[min(36rem,var(--available-height))] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto p-1"
      >
        <div role="radiogroup" aria-label="What starts it" className="flex flex-col">
          {kinds.map((kind) => (
            <button
              key={kind.value}
              type="button"
              role="radio"
              aria-checked={form.trigger === kind.value}
              onClick={() => props.onChange({ trigger: kind.value })}
              className="flex h-[30px] items-center gap-2 rounded-md px-2 text-left text-ui transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset"
            >
              <span className="min-w-0 flex-1 truncate">{kind.label}</span>
              {form.trigger === kind.value && (
                <CheckIcon aria-hidden size={16} className="shrink-0 text-muted-foreground" />
              )}
            </button>
          ))}
        </div>
        {form.trigger !== "manual" && <div aria-hidden className="mx-1 my-1.5 h-px bg-border" />}
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
              className="font-mono"
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
              className="w-full min-w-0"
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
  const zones = useMemo(
    () => timeZones(form.timezone).map((value) => ({ value, label: value.replaceAll("_", " ") })),
    [form.timezone],
  );
  const timed =
    form.cadence === "daily" || form.cadence === "weekdays" || form.cadence === "weekly";
  const own = fieldErrors(form);
  const next = scheduleFields.some((field) => own[field])
    ? undefined
    : upcomingRuns(scheduleFromForm(form, props.now), props.now).map((at) =>
        formatRunInZone(at, form.timezone),
      );
  return (
    <div className="flex flex-col">
      <Field label="Repeat">
        <Select
          label="Repeat"
          value={form.cadence}
          options={cadences}
          onValueChange={(cadence) => onChange({ cadence })}
          className="w-full min-w-0"
        />
      </Field>
      {form.cadence === "weekly" && (
        <Field label="Day">
          <Select
            label="Day"
            value={form.day}
            options={days}
            onValueChange={(day) => onChange({ day })}
            className="w-full min-w-0"
          />
        </Field>
      )}
      {timed && (
        <Field label="At" htmlFor="automation-time" error={errors.time}>
          <TimeInput
            id="automation-time"
            value={form.time}
            onBlur={() => undefined}
            onValueChange={(time) => onChange({ time })}
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
            className="w-full min-w-0"
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
      <Field label="Time zone" error={errors.timezone}>
        <Select
          label="Time zone"
          value={form.timezone}
          options={zones}
          onValueChange={(timezone) => onChange({ timezone })}
          className="w-full min-w-0"
        />
      </Field>
      <Field label="If a run is missed">
        <Select
          label="If a run is missed"
          value={form.missedRun}
          options={missed}
          onValueChange={(missedRun) => onChange({ missedRun })}
          className="w-full min-w-0"
        />
      </Field>
      <p aria-live="polite" className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
        {next === undefined ? "" : next.length ? `Next: ${next.join(", ")}` : "No upcoming run"}
      </p>
    </div>
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
    <div className="flex flex-col gap-1 px-2 py-1">
      <div
        className={cn(
          "flex gap-3",
          props.stacked ? "flex-col gap-1" : "items-center justify-between",
        )}
      >
        <label htmlFor={props.htmlFor} className="shrink-0 text-ui text-muted-foreground">
          {props.label}
        </label>
        <div className={props.stacked ? "w-full" : "w-44 min-w-0"}>{props.children}</div>
      </div>
      {props.error && (
        <p id={errorId} className="text-xs text-destructive">
          {props.error}
        </p>
      )}
    </div>
  );
}
