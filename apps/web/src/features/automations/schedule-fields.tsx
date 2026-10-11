import { useMemo } from "react";
import { Input } from "@/components/ui/input.tsx";
import { TimeInput } from "./time-input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useNow } from "@/lib/time.ts";
import { Row, invalidProps, visible } from "./form-row.tsx";
import type { AutomationFormApi } from "./use-automation-form.ts";
import { AutomationForm, hourSteps, scheduleFromForm } from "./automation-values.ts";
import { formatRunInZone, timeZones, upcomingRuns, weekdayName, weekdays } from "./schedule.ts";

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
const hoursLabel = (hours: number) => (hours === 1 ? "Every hour" : `Every ${hours} hours`);

/** Every-few-hours steps; a saved interval the list doesn't offer stays selectable. */
function hourOptions(current: number) {
  const steps: number[] = hourSteps.includes(current as (typeof hourSteps)[number])
    ? [...hourSteps]
    : [...hourSteps, current].toSorted((a, b) => a - b);
  return steps.map((hours) => ({ value: String(hours), label: hoursLabel(hours) }));
}

/** Repeat, time and day (or a raw expression), the zone it runs in, and a read-back. */
export function ScheduleFields(props: { form: AutomationFormApi }) {
  const { form } = props;
  return (
    <>
      <div className="contents">
        <form.Field name="cadence">
          {(field) => (
            <Row label="Repeat">
              <Select
                label="Repeat"
                value={field.state.value}
                options={cadences}
                onValueChange={(value) => field.handleChange(value)}
                className="w-full min-w-0"
              />
            </Row>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.cadence}>
          {(cadence) => (
            <>
              {cadence === "weekly" && (
                <form.Field name="day">
                  {(field) => (
                    <Row label="Day">
                      <Select
                        label="Day"
                        value={field.state.value}
                        options={days}
                        onValueChange={(value) => field.handleChange(value)}
                        className="w-full min-w-0"
                      />
                    </Row>
                  )}
                </form.Field>
              )}
              {(cadence === "daily" || cadence === "weekdays" || cadence === "weekly") && (
                <form.Field name="time">
                  {(field) => {
                    const error = visible(field.state.meta);
                    return (
                      <Row label="At" htmlFor="automation-time" errors={error}>
                        <TimeInput
                          id="automation-time"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onValueChange={(value) => field.handleChange(value)}
                          {...invalidProps("automation-time", error)}
                        />
                      </Row>
                    );
                  }}
                </form.Field>
              )}
              {cadence === "hourly" && (
                <form.Field name="every">
                  {(field) => (
                    <Row label="How often">
                      <Select
                        label="How often"
                        value={String(field.state.value)}
                        options={hourOptions(field.state.value)}
                        onValueChange={(value) => field.handleChange(Number(value))}
                        className="w-full min-w-0"
                      />
                    </Row>
                  )}
                </form.Field>
              )}
              {cadence === "custom" && (
                <form.Field name="syntax">
                  {(field) => (
                    <Row label="Syntax" className="items-start">
                      <SegmentedControl
                        label="Syntax"
                        value={field.state.value}
                        options={syntaxes}
                        onValueChange={(value) => field.handleChange(value)}
                      />
                    </Row>
                  )}
                </form.Field>
              )}
            </>
          )}
        </form.Subscribe>
      </div>
      <form.Subscribe selector={(state) => state.values.cadence === "custom"}>
        {(custom) =>
          custom && (
            <form.Field name="expression">
              {(field) => {
                const error = visible(field.state.meta);
                return (
                  <Row label="Expression" htmlFor="automation-expression" errors={error}>
                    <Input
                      id="automation-expression"
                      name="expression"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onValueChange={(value) => field.handleChange(value)}
                      placeholder="FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=8;BYMINUTE=30"
                      className="font-mono"
                      {...invalidProps("automation-expression", error)}
                    />
                  </Row>
                );
              }}
            </form.Field>
          )
        }
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.values}>
        {(values) => <ScheduleReadBack values={values} />}
      </form.Subscribe>
    </>
  );
}

/** A picker over the browser's IANA zones; keeps the saved zone through an edit. */
export function TimeZoneField(props: {
  value: string;
  error: string | undefined;
  onBlur(): void;
  onChange(value: string): void;
}) {
  const zones = useMemo(
    () => timeZones(props.value).map((value) => ({ value, label: value.replaceAll("_", " ") })),
    [props.value],
  );
  return (
    <Row label="Time zone" errors={props.error}>
      <Select
        label="Time zone"
        value={props.value}
        options={zones}
        onValueChange={(value) => {
          props.onChange(value);
          props.onBlur();
        }}
        className="w-full min-w-0"
      />
    </Row>
  );
}

const scheduleFields = new Set(["time", "every", "expression", "timezone"]);

/**
 * Reads the schedule back as soon as its own fields are valid, before the rest is filled:
 * how it repeats, in which zone, and its next three starts by the daemon's own rules.
 */
function ScheduleReadBack(props: { values: AutomationForm }) {
  const now = useNow();
  if (props.values.trigger !== "schedule") return null;
  const issues = AutomationForm.safeParse(props.values).error?.issues ?? [];
  if (issues.some((issue) => scheduleFields.has(String(issue.path[0])))) return null;
  const { timezone } = props.values;
  const schedule = scheduleFromForm(props.values, now);
  const next = upcomingRuns(schedule, now).map((at) => formatRunInZone(at, timezone));
  return (
    <p aria-live="polite" className="-mt-1 mb-4 text-sm text-muted-foreground">
      {next[0] && <>Next run {next[0]}</>}
    </p>
  );
}
