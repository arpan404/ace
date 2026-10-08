import { ProviderKind, type Automation, type AutomationSchedule } from "@ace/protocol";
import { z } from "zod";
import { presetToSchedule, scheduleToPreset, weekdays, type SchedulePreset } from "./schedule.ts";

/** An IANA zone this browser can format in ("Europe/London"). */
function isTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    return Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}

/** Everything the create/edit form holds. Flat, so each control binds to one field. */
export const AutomationForm = z
  .object({
    title: z.string().trim().min(1, "Give the automation a name.").max(256),
    prompt: z.string().trim().min(1, "Say what the agent should do.").max(32_768),
    workspace: z.string().min(1, "Choose a project."),
    provider: ProviderKind,
    permissionMode: z.string().max(4096).optional(),
    model: z.string().trim().max(256),
    trigger: z.enum(["schedule", "github", "file", "manual"]),
    cadence: z.enum(["daily", "weekdays", "weekly", "hourly", "custom"]),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time, like 09:30."),
    day: z.enum(weekdays),
    every: z
      .number("Enter whole hours from 1 to 23.")
      .int("Enter whole hours from 1 to 23.")
      .min(1, "Enter whole hours from 1 to 23.")
      .max(23, "Enter whole hours from 1 to 23."),
    timezone: z.string().refine(isTimeZone, "Choose a time zone from the list."),
    /** An existing schedule's DTSTART, which anchors its recurrence; new ones start now. */
    startAt: z.number().optional(),
    syntax: z.enum(["rrule", "cron"]),
    expression: z.string().trim(),
    repository: z.string().trim(),
    event: z.enum(["pr_changed", "ci_failed", "review_comment", "issue_labelled"]),
    label: z.string().trim().max(256),
    /** File trigger globs, one per line. */
    paths: z.string(),
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
    if (form.trigger === "github" && form.event === "issue_labelled" && !form.label)
      ctx.addIssue({ code: "custom", path: ["label"], message: "Name the label to watch for." });
    if (form.trigger === "file" && !globs(form.paths).length)
      ctx.addIssue({ code: "custom", path: ["paths"], message: "Add at least one path." });
  });
export type AutomationForm = z.infer<typeof AutomationForm>;

/** The file trigger's globs: one per line, blank lines dropped. */
export const globs = (paths: string) =>
  paths
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Hour intervals offered for "Every few hours": each divides a day, so runs don't drift. */
export const hourSteps = [1, 2, 3, 4, 6, 8, 12] as const;

export function blankForm(workspace: string, timezone: string): AutomationForm {
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
    timezone,
    syntax: "rrule",
    expression: "",
    repository: "",
    event: "pr_changed",
    label: "",
    paths: "",
    worktree: true,
    missedRun: "run_once",
  };
}

export function formFromAutomation(automation: Automation, localZone: string): AutomationForm {
  const form: AutomationForm = {
    ...blankForm(automation.workspace, localZone),
    title: automation.title,
    prompt: automation.prompt,
    provider: automation.provider,
    model: automation.model ?? "",
    permissionMode: automation.permissionMode,
    worktree: automation.worktree,
    missedRun: automation.missedRun,
  };
  const trigger = automation.trigger;
  if (trigger.kind === "github")
    return {
      ...form,
      trigger: "github",
      repository: trigger.repository,
      event: trigger.event,
      label: trigger.label ?? "",
    };
  if (trigger.kind === "file") return { ...form, trigger: "file", paths: trigger.paths.join("\n") };
  if (trigger.kind !== "schedule") return { ...form, trigger: "manual" };
  const preset = scheduleToPreset(trigger.schedule);
  const scheduled = {
    ...form,
    trigger: "schedule" as const,
    cadence: preset.kind,
    timezone: trigger.schedule.timezone,
    startAt: trigger.schedule.startAt,
  };
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
 * The schedule the form describes, anchored where it will be saved: the existing DTSTART when
 * editing, else `now`. The read-back and the save both use this, so the preview is what runs.
 */
export function scheduleFromForm(form: AutomationForm, now: number): AutomationSchedule {
  return presetToSchedule(presetFromForm(form), form.timezone, form.startAt ?? now);
}

/** The trigger a submitted form describes, keeping what the form doesn't show. */
function triggerFromForm(
  form: AutomationForm,
  now: number,
  previous: Automation["trigger"] | undefined,
): Automation["trigger"] {
  switch (form.trigger) {
    case "manual":
      return { kind: "manual" };
    case "file":
      return { kind: "file", paths: globs(form.paths) };
    case "github": {
      const before = previous?.kind === "github" ? previous : undefined;
      // The label only means something for "an issue is labelled".
      const label = form.event === "issue_labelled" && form.label ? form.label : undefined;
      return {
        kind: "github",
        repository: form.repository,
        event: form.event,
        ...(label ? { label } : {}),
        ...(before?.pullRequest !== undefined ? { pullRequest: before.pullRequest } : {}),
        pollIntervalMs: before?.pollIntervalMs ?? 300_000,
      };
    }
    case "schedule":
      return { kind: "schedule", schedule: scheduleFromForm(form, now) };
  }
}

/**
 * The protocol definition for a submitted form. Editing keeps the original id, enabled state,
 * concurrency, jitter and the trigger details the form doesn't show (a GitHub trigger's pull
 * request and poll interval, a schedule's start).
 */
export function automationFromForm(
  form: AutomationForm,
  context: { id: string; now: number; previous?: Automation | undefined },
): Automation {
  const previous = context.previous;
  const trigger = triggerFromForm(form, context.now, previous?.trigger);
  return {
    id: previous?.id ?? context.id,
    title: form.title,
    enabled: previous?.enabled ?? true,
    workspace: form.workspace,
    provider: form.provider,
    ...(form.permissionMode ? { permissionMode: form.permissionMode } : {}),
    ...(form.model ? { model: form.model } : {}),
    prompt: form.prompt,
    worktree: form.worktree,
    trigger,
    missedRun: form.missedRun,
    concurrency: previous?.concurrency ?? 1,
    jitterMs: previous?.jitterMs ?? 0,
  };
}
