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
  cadencePatch,
  cadences,
  chosenStart,
  dateIn,
  githubEventChoices as events,
  hourOptions,
  localTimeZone,
  minuteOptions,
  missedRunChoices as missed,
  nextQuarter,
  syntaxChoices as syntaxes,
  timeZones,
  triggerKinds as kinds,
  triggerPatch,
  upcomingLine,
  upcomingStarts,
  weekdayChoices as days,
  whenSummary,
  type FieldErrors,
} from "@ace/ui-core/automations";
import { dateLabel } from "@/components/ui/date-grid.ts";
import { DateTimePicker, type DateTime } from "@/components/ui/date-time-picker.tsx";
import { displayTime, TimePicker } from "@/components/ui/time-picker.tsx";
import { cityOf } from "@/components/ui/zone-search.tsx";

/*
 * When an automation runs, as the strip's first control: a list of the four kinds, then the
 * chosen kind's fields: a schedule's repeat, time, zone and missed-run rule with its next three
 * starts; a GitHub repository and event; file globs. Validated by the form's own schema; the
 * words and rules live in `@ace/ui-core/automations`, shared with the phone.
 */

export { fieldErrors, whenFields, whenSummary, type FieldErrors } from "@ace/ui-core/automations";

/** "Oct 25, 9:30 AM", with the zone's city when it isn't this computer's. */
function momentText(moment: { date: string; time: string }, today: string, timezone: string) {
  const zone = timezone === localTimeZone() ? "" : ` · ${cityOf(timezone)}`;
  return `${dateLabel(moment.date, today)}, ${displayTime(moment.time)}${zone}`;
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
        className="flex max-h-[min(36rem,var(--available-height))] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto p-1"
      >
        <WhenFields form={form} onChange={props.onChange} errors={props.errors} now={now} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * What the When popover holds, for any surface that edits when an automation runs: the kind of
 * trigger, then that kind's own fields.
 */
export function WhenFields(props: {
  form: AutomationForm;
  onChange(patch: Partial<AutomationForm>): void;
  errors: FieldErrors;
  now: number;
}) {
  const { form } = props;
  const suggested = useProjectRepository(form.workspace);
  return (
    <>
      <Field label="Runs">
        <Select
          label="Runs"
          value={form.trigger}
          options={kinds}
          onValueChange={(trigger) =>
            // A GitHub trigger starts from the project's own repository; the field stays editable.
            props.onChange(triggerPatch(form, trigger, suggested))
          }
          className="h-7 w-full min-w-0"
        />
      </Field>
      <TriggerFields {...props} />
    </>
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
  const next = upcomingStarts(form, props.now);
  return (
    <div className="flex flex-col">
      <Field label="Repeat">
        <Select
          label="Repeat"
          value={form.cadence}
          options={cadences}
          onValueChange={(cadence) => onChange(cadencePatch(form, cadence, props.now))}
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
        {upcomingLine(next)}
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
