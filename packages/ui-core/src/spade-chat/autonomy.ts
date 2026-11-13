import { z } from "zod";

/*
 * How much a bot may do on its own, and whether it is still on its task. Each bot has an access
 * level: `ask` asks before it changes anything, `auto_review` lets a review model approve routine
 * steps and asks the person about the rest, `full_access` never asks. A bot keeps working until
 * its task is done; while it does, Spade says so (`continuing`), and a task waiting on the person
 * is `blocked_on_person`. Parsed leniently: a value this client doesn't know reads as unknown.
 */

export const spadeAccessLevels = ["ask", "auto_review", "full_access"] as const;
export type SpadeAccess = (typeof spadeAccessLevels)[number];

/** A new bot starts on Auto-review; a bot from before access levels asks. */
export const spadeNewBotAccess: SpadeAccess = "auto_review";

/** Each level's name and its one plain line, in the order the choice shows them. */
export const spadeAccessChoices: readonly { value: SpadeAccess; label: string; line: string }[] = [
  { value: "ask", label: "Ask", line: "Asks before it changes anything" },
  {
    value: "auto_review",
    label: "Auto-review",
    line: "A reviewer approves routine work; asks you about payments, sending as you, publishing and deletes outside its folder",
  },
  {
    value: "full_access",
    label: "Full access",
    line: "Never asks. You keep Stop, spend limits and the activity log",
  },
];

export const spadeAccessLabel = (access: SpadeAccess): string =>
  spadeAccessChoices.find((choice) => choice.value === access)?.label ?? "Ask";

/** An agent's `access`; undefined from a Spade before access levels or for a level unknown here. */
export function parseSpadeAccess(raw: unknown): SpadeAccess | undefined {
  const parsed = z.enum(spadeAccessLevels).safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export type SpadeTaskState = "working" | "blocked_on_person" | "done";

/** Where a bot is on its task; undefined from a Spade before tasks that carry on. */
export interface SpadeTaskProgress {
  state: SpadeTaskState;
  /** It is carrying on by itself, between the person's messages. */
  continuing: boolean;
  /** Its current step, in its own few words. */
  step: string | undefined;
}

const taskStateShape = z.enum(["working", "blocked_on_person", "done"]);
const taskObjectShape = z.object({
  state: taskStateShape,
  continuing: z.boolean().catch(false).optional(),
  step: z.string().nullish().catch(undefined),
});

/**
 * From an agent's fields: `task_state` as a word or as `{state, continuing, step}`, with
 * `continuing` and `step` beside it when it is a word.
 */
export function parseSpadeTaskProgress(
  record: Record<string, unknown>,
): SpadeTaskProgress | undefined {
  const raw = record.task_state;
  const continuing = record.continuing === true;
  const step = typeof record.step === "string" && record.step ? record.step : undefined;
  const word = taskStateShape.safeParse(raw);
  if (word.success) return { state: word.data, continuing, step };
  const object = taskObjectShape.safeParse(raw);
  if (!object.success) return undefined;
  return {
    state: object.data.state,
    continuing: object.data.continuing ?? continuing,
    step: object.data.step || step,
  };
}

/**
 * The line a bot's chat and roster show for its task: "Flights is working on it" with its step
 * while it carries on by itself, "Flights needs you" while the task waits on the person, and
 * nothing once it is done or while it only answers the person's message.
 */
export function spadeTaskLine(
  name: string,
  task: SpadeTaskProgress | undefined,
  /** The step's words when the task carries none: the agent's live status. */
  status?: string | undefined,
): { sentence: string; step: string | undefined; tone: "working" | "needs-you" } | undefined {
  if (!task) return undefined;
  if (task.state === "blocked_on_person")
    return { sentence: `${name} needs you`, step: undefined, tone: "needs-you" };
  if (task.state === "working" && task.continuing)
    return {
      sentence: `${name} is working on it`,
      step: task.step ?? status,
      tone: "working",
    };
  return undefined;
}
