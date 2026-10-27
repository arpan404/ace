import { Automation } from "@ace/protocol";
import {
  AutomationForm,
  automationFromForm,
  blankForm,
  cadencePatch,
  cadences,
  chosenStart,
  dateIn,
  fieldErrors,
  formFromAutomation,
  githubEventChoices,
  hourOptions,
  minuteOptions,
  missedRunChoices,
  nextDateFor,
  onceInstant,
  syntaxChoices,
  triggerKinds,
  triggerPatch,
  upcomingLine,
  upcomingStarts,
  wallMoment,
  weekdayChoices,
  whenSummary,
  choicesFromModel,
} from "@ace/ui-core/automations";
import { selectNewThreadAgent, type NewThreadAgents } from "@ace/ui-core/mobile";
import { z } from "zod";

/*
 * The automation editor's form on the phone: the web's own `AutomationForm`, opened from a
 * stored automation (or blank), checked and described after every change (`whenSummary`, the
 * next starts, each field's problem), and saved as the protocol definition. Native date and time
 * pickers hand over instants; this module turns them into the form's wall-clock values in the
 * schedule's zone, so the phone never formats a schedule itself. The model comes from the same
 * picker New thread uses: a picked key and account become the catalog id the run starts on.
 */

const Zone = z.string().min(1).max(128).optional();
/** The form's fields without its cross-field checks, so a half-filled form still reads. */
const FormShape = z.object(AutomationForm.shape);
type Form = z.infer<typeof FormShape>;
/** What the shared model picker holds: the option key, its account and the effort. */
const Pick = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().min(1).max(600),
  account: z.string().min(1).max(256).optional(),
  effort: z.string().min(1).max(64).optional(),
});
type Pick = z.infer<typeof Pick>;

export const FormOpen = z.object({
  type: z.literal("automations.form.open"),
  automation: Automation.optional(),
  /** A new automation's project. */
  workspace: z.string().max(4096).optional(),
  zone: Zone,
});
/** One change a native control makes; `at`, `time` and `startsAt` are instants from a picker. */
const Change = z.object({
  cadence: AutomationForm.shape.cadence.optional(),
  trigger: AutomationForm.shape.trigger.optional(),
  /** A one-off run's date and time. */
  at: z.number().int().optional(),
  /** A repeating schedule's time of day. */
  time: z.number().int().optional(),
  /** When a repeating schedule begins; null starts it now. */
  startsAt: z.number().int().nullable().optional(),
});
export const FormPreview = z.object({
  type: z.literal("automations.form.preview"),
  form: FormShape,
  change: Change.optional(),
});
export const FormSave = z.object({
  type: z.literal("automations.save"),
  form: FormShape,
  pick: Pick.optional(),
  /** A new automation's id, made on the phone; an edit keeps `previous.id`. */
  id: z.string().min(1).max(256),
  previous: Automation.optional(),
  /** The revision on screen, so an edit made elsewhere since is refused, not overwritten. */
  revision: z.number().int().positive().nullable().optional(),
});

interface FormDeps {
  now(): number;
  zone(): string;
  agents(): Promise<NewThreadAgents | undefined>;
}
type Reply = Record<string, unknown> & { ok: boolean };

/** The order a person fixes problems in: what it is, then where, then when. */
const order: (keyof Form)[] = [
  "title",
  "prompt",
  "workspace",
  "provider",
  "time",
  "date",
  "every",
  "minutes",
  "startsAt",
  "timezone",
  "expression",
  "repository",
  "label",
  "paths",
];

/** Everything the When controls draw from a form, with the next starts. */
export function describeForm(form: Form, now: number) {
  const errors = fieldErrors(form);
  const first = order.find((field) => errors[field]);
  const upcoming = upcomingStarts(form, now) ?? null;
  const start = chosenStart(form);
  const today = dateIn(now, form.timezone);
  return {
    form,
    summary: whenSummary(form, now),
    errors,
    problem: first ? (errors[first] ?? null) : null,
    upcoming,
    line: upcomingLine(upcoming ?? undefined),
    /** The pickers' values as instants in the schedule's zone. */
    instants: {
      at: onceInstant({ date: form.date || today, time: form.time }, form.timezone) ?? now,
      time: onceInstant({ date: today, time: form.time }, form.timezone) ?? now,
      startsAt: start !== undefined && start > now ? start : null,
    },
    today: onceInstant({ date: today, time: "00:00" }, form.timezone) ?? now,
    hours: hourOptions(form.every),
    minutes: minuteOptions(form.minutes),
  };
}

/** The form after one native change. */
export function changeForm(form: Form, change: z.infer<typeof Change>, now: number): Form {
  let next: Form = { ...form };
  if (change.trigger) next = { ...next, ...triggerPatch(next, change.trigger, undefined) };
  if (change.cadence) next = { ...next, ...cadencePatch(next, change.cadence, now) };
  if (change.at !== undefined) next = { ...next, ...wallMoment(change.at, next.timezone) };
  if (change.time !== undefined)
    next = { ...next, time: wallMoment(change.time, next.timezone).time };
  if (change.startsAt === null) next = { ...next, startsAt: "" };
  else if (change.startsAt !== undefined) {
    const moment = wallMoment(change.startsAt, next.timezone);
    next = { ...next, startsAt: `${moment.date}T${moment.time}` };
  }
  return next;
}

/** The lists every When control offers, sent once with the form. */
const choices = {
  triggers: triggerKinds,
  cadences,
  weekdays: weekdayChoices,
  syntaxes: syntaxChoices,
  events: githubEventChoices,
  missed: missedRunChoices,
};

export async function formOpen(request: z.infer<typeof FormOpen>, deps: FormDeps): Promise<Reply> {
  const zone = request.zone ?? deps.zone();
  const now = deps.now();
  const agents = await deps.agents().catch(() => undefined);
  const stored = request.automation;
  let form: Form = stored
    ? formFromAutomation(stored, zone)
    : blankForm(request.workspace ?? "", zone);
  let pick: Pick | null = null;
  if (stored) {
    const choice = choicesFromModel(stored, agents?.models);
    if (choice.model)
      pick = {
        provider: stored.provider,
        key: choice.model,
        ...(choice.account ? { account: choice.account } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
      };
  } else if (agents) {
    // A new automation starts on what a new thread would: the ready agent and its default model.
    const start = selectNewThreadAgent(agents, {});
    if (start.ok) {
      form = { ...form, provider: start.provider };
      pick = {
        provider: start.provider,
        key: start.model.key,
        account: start.model.account,
        ...(start.effort ? { effort: start.effort } : {}),
      };
    }
  }
  if (form.cadence === "once" && !form.date)
    form = { ...form, date: nextDateFor(form.time, now, form.timezone) };
  return { ok: true, pick, choices, ...describeForm(form, now) };
}

export function formPreview(request: z.infer<typeof FormPreview>, deps: FormDeps): Reply {
  const now = deps.now();
  const form = request.change ? changeForm(request.form, request.change, now) : request.form;
  return { ok: true, ...describeForm(form, now) };
}

/** The form with the picked model as the automation stores it: provider, catalog id, account. */
async function withPick(form: Form, pick: Pick | undefined, deps: FormDeps) {
  if (!pick) return { form };
  const agents = await deps.agents().catch(() => undefined);
  if (!agents)
    return { problem: "Still reading this computer's coding agents. Try again in a moment." };
  const start = selectNewThreadAgent(agents, {
    provider: pick.provider,
    model: pick.key,
    account: pick.account,
    effort: pick.effort,
  });
  if (!start.ok) return { problem: start.reason };
  const { effort: _effort, instance: _instance, ...rest } = form;
  return {
    form: {
      ...rest,
      provider: start.provider,
      model: start.model.id,
      instance: start.model.account,
      ...(start.effort ? { effort: start.effort } : {}),
    },
  };
}

export async function formSave(
  request: z.infer<typeof FormSave>,
  deps: FormDeps,
  put: (put: {
    automation: Automation;
    expectedRevision: number | null | undefined;
  }) => Promise<Reply>,
): Promise<Reply> {
  const picked = await withPick(request.form, request.pick, deps);
  if (!picked.form) return { ok: false, error: picked.problem };
  const checked = AutomationForm.safeParse(picked.form);
  if (!checked.success) {
    const described = describeForm(picked.form, deps.now());
    return {
      ok: false,
      error: described.problem ?? "Check the automation's fields and try again.",
    };
  }
  const automation = automationFromForm(checked.data, {
    id: request.id,
    now: deps.now(),
    previous: request.previous,
  });
  const reply = await put({
    automation,
    expectedRevision: request.previous ? request.revision : null,
  });
  return reply.ok ? { ok: true, id: automation.id } : reply;
}
