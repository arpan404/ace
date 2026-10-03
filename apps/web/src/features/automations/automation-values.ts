import { ProviderKind, type Automation } from "@ace/protocol";
import { z } from "zod";
import { presetToSchedule, scheduleToPreset, weekdays, type SchedulePreset } from "./schedule.ts";

/** Everything the create/edit form holds. Flat, so each control binds to one field. */
export const AutomationForm = z
  .object({
    title: z.string().trim().min(1, "Give the automation a name.").max(256),
    prompt: z.string().trim().min(1, "Say what the agent should do.").max(32_768),
    workspace: z.string().min(1, "Choose a project."),
    provider: ProviderKind,
    model: z.string().trim().max(256),
    trigger: z.enum(["schedule", "github", "manual"]),
    cadence: z.enum(["daily", "weekdays", "weekly", "hourly", "custom"]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, like 09:30."),
    day: z.enum(weekdays),
    every: z
      .number()
      .int("Whole hours only.")
      .min(1, "At least 1 hour.")
      .max(23, "At most 23 hours."),
    syntax: z.enum(["rrule", "cron"]),
    expression: z.string().trim(),
    repository: z.string().trim(),
    event: z.enum(["pr_changed", "ci_failed", "review_comment", "issue_labelled"]),
    worktree: z.boolean(),
    missedRun: z.enum(["skip", "run_once"]),
  })
  .superRefine((form, ctx) => {
    if (form.trigger === "schedule" && form.cadence === "custom") {
      if (!form.expression)
        ctx.addIssue({ code: "custom", path: ["expression"], message: "Enter a schedule." });
      else if (form.syntax === "cron" && form.expression.split(/\s+/).length !== 5)
        ctx.addIssue({
          code: "custom",
          path: ["expression"],
          message: "Cron needs five fields: minute hour day month weekday.",
        });
      else if (form.syntax === "rrule" && !/FREQ=/i.test(form.expression))
        ctx.addIssue({
          code: "custom",
          path: ["expression"],
          message: "An RRULE needs FREQ, like FREQ=WEEKLY;BYDAY=MO.",
        });
    }
    if (form.trigger === "github" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(form.repository))
      ctx.addIssue({
        code: "custom",
        path: ["repository"],
        message: "Use owner/name, like arpan404/ace.",
      });
  });
export type AutomationForm = z.infer<typeof AutomationForm>;

export function blankForm(workspace: string): AutomationForm {
  return {
    title: "",
    prompt: "",
    workspace,
    provider: "claude",
    model: "",
    trigger: "schedule",
    cadence: "daily",
    time: "09:00",
    day: "MO",
    every: 6,
    syntax: "rrule",
    expression: "",
    repository: "",
    event: "pr_changed",
    worktree: true,
    missedRun: "run_once",
  };
}

export function formFromAutomation(automation: Automation): AutomationForm {
  const form: AutomationForm = {
    ...blankForm(automation.workspace),
    title: automation.title,
    prompt: automation.prompt,
    provider: automation.provider,
    model: automation.model ?? "",
    worktree: automation.worktree,
    missedRun: automation.missedRun,
  };
  const trigger = automation.trigger;
  if (trigger.kind === "github")
    return { ...form, trigger: "github", repository: trigger.repository, event: trigger.event };
  if (trigger.kind !== "schedule") return { ...form, trigger: "manual" };
  const preset = scheduleToPreset(trigger.schedule);
  const scheduled = { ...form, trigger: "schedule" as const, cadence: preset.kind };
  switch (preset.kind) {
    case "custom":
      return { ...scheduled, syntax: preset.syntax, expression: preset.expression };
    case "hourly":
      return { ...scheduled, every: preset.every };
    case "weekly":
      return { ...scheduled, day: preset.day, time: preset.time };
    default:
      return { ...scheduled, time: preset.time };
  }
}

export function presetFromForm(form: AutomationForm): SchedulePreset {
  switch (form.cadence) {
    case "daily":
    case "weekdays":
      return { kind: form.cadence, time: form.time };
    case "weekly":
      return { kind: "weekly", day: form.day, time: form.time };
    case "hourly":
      return { kind: "hourly", every: form.every };
    case "custom":
      return { kind: "custom", syntax: form.syntax, expression: form.expression };
  }
}

/**
 * The protocol definition for a submitted form. Editing keeps the original id, enabled state,
 * concurrency, jitter and file triggers the form doesn't show.
 */
export function automationFromForm(
  form: AutomationForm,
  context: { id: string; now: number; timezone: string; previous?: Automation | undefined },
): Automation {
  const previous = context.previous;
  const trigger: Automation["trigger"] =
    form.trigger === "manual"
      ? previous?.trigger.kind === "file"
        ? previous.trigger
        : { kind: "manual" }
      : form.trigger === "github"
        ? {
            kind: "github",
            repository: form.repository,
            event: form.event,
            pollIntervalMs:
              previous?.trigger.kind === "github" ? previous.trigger.pollIntervalMs : 300_000,
          }
        : {
            kind: "schedule",
            schedule: presetToSchedule(
              presetFromForm(form),
              previous?.trigger.kind === "schedule"
                ? previous.trigger.schedule.timezone
                : context.timezone,
              previous?.trigger.kind === "schedule"
                ? previous.trigger.schedule.startAt
                : context.now,
            ),
          };
  return {
    id: previous?.id ?? context.id,
    title: form.title,
    enabled: previous?.enabled ?? true,
    workspace: form.workspace,
    provider: form.provider,
    ...(form.model ? { model: form.model } : {}),
    prompt: form.prompt,
    worktree: form.worktree,
    trigger,
    missedRun: form.missedRun,
    concurrency: previous?.concurrency ?? 1,
    jitterMs: previous?.jitterMs ?? 0,
  };
}
