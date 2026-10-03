import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Select } from "@/components/ui/select.tsx";
import { useNow } from "@/lib/time.ts";
import { Row, visible } from "./form-row.tsx";
import type { AutomationFormApi } from "./use-automation-form.ts";
import { AutomationForm, presetFromForm } from "./automation-values.ts";
import {
  describeSchedule,
  localTimeZone,
  presetToSchedule,
  weekdayName,
  weekdays,
} from "./schedule.ts";

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

/** Repeat, time and day, or a raw expression; with a plain-English read-back. */
export function ScheduleFields(props: { form: AutomationFormApi }) {
  const { form } = props;
  return (
    <>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <form.Field name="cadence">
          {(field) => (
            <Row label="Repeat">
              <Select
                label="Repeat"
                value={field.state.value}
                options={cadences}
                onValueChange={(value) => field.handleChange(value)}
                className="w-full"
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
                        className="w-full"
                      />
                    </Row>
                  )}
                </form.Field>
              )}
              {(cadence === "daily" || cadence === "weekdays" || cadence === "weekly") && (
                <form.Field name="time">
                  {(field) => (
                    <Row label="At" htmlFor="automation-time" errors={visible(field.state.meta)}>
                      <Input
                        id="automation-time"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onValueChange={(value) => field.handleChange(value)}
                        placeholder="09:00"
                        className="tabular-nums"
                      />
                    </Row>
                  )}
                </form.Field>
              )}
              {cadence === "hourly" && (
                <form.Field name="every">
                  {(field) => (
                    <Row
                      label="Every how many hours"
                      htmlFor="automation-every"
                      errors={visible(field.state.meta)}
                    >
                      <Input
                        id="automation-every"
                        inputMode="numeric"
                        value={String(field.state.value)}
                        onBlur={field.handleBlur}
                        onValueChange={(value) => field.handleChange(Number(value))}
                        className="tabular-nums"
                      />
                    </Row>
                  )}
                </form.Field>
              )}
              {cadence === "custom" && (
                <form.Field name="syntax">
                  {(field) => (
                    <Row label="Syntax">
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
              {(field) => (
                <Row
                  label="Expression"
                  htmlFor="automation-expression"
                  errors={visible(field.state.meta)}
                >
                  <Input
                    id="automation-expression"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onValueChange={(value) => field.handleChange(value)}
                    placeholder="FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=8;BYMINUTE=30"
                    className="font-mono"
                  />
                </Row>
              )}
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

const scheduleFields = new Set(["time", "every", "expression"]);

/** Reads the schedule back as soon as its own fields are valid, before the rest is filled. */
function ScheduleReadBack(props: { values: AutomationForm }) {
  const now = useNow();
  if (props.values.trigger !== "schedule") return null;
  const issues = AutomationForm.safeParse(props.values).error?.issues ?? [];
  if (issues.some((issue) => scheduleFields.has(String(issue.path[0])))) return null;
  const text = describeSchedule(
    presetToSchedule(presetFromForm(props.values), localTimeZone(), now),
  );
  return (
    <p aria-live="polite" className="-mt-1 mb-4 text-sm text-muted-foreground">
      Runs: <span className="text-foreground">{text}</span>
    </p>
  );
}
