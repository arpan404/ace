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

export type SpadeTaskState = "working" | "waiting" | "blocked_on_person" | "done";

/** Where a bot is on its task; undefined from a Spade before tasks that carry on. */
export interface SpadeTaskProgress {
  state: SpadeTaskState;
  /** It is carrying on by itself, between the person's messages. */
  continuing: boolean;
  /** Its current step, in its own few words. */
  step: string | undefined;
}

const taskObjectShape = z.object({
  status: z.enum(["working", "waiting", "blocked_on_person", "done"]),
  note: z.string().nullish().catch(undefined),
});

/** The server's task state and its separate continuation flag. */
export function parseSpadeTaskProgress(
  record: Record<string, unknown>,
): SpadeTaskProgress | undefined {
  const parsed = taskObjectShape.safeParse(record.task_state);
  if (!parsed.success) return undefined;
  return {
    state: parsed.data.status,
    continuing: record.continuing === true,
    step: parsed.data.note || undefined,
  };
}

/** A task's line: its sentence, the step it is on, and whether it works or waits on the person. */
export interface SpadeTaskLine {
  sentence: string;
  step: string | undefined;
  tone: "working" | "waiting" | "needs-you";
}

/**
 * The line a bot's chat and roster show for its task: "Flights is working on it" with its step
 * while it carries on by itself, "Flights is waiting" with its note while the task waits on
 * something else (a job, a reply from another bot, its next step's time), "Flights needs you"
 * while it waits on the person, and nothing once it is done or while it only answers the
 * person's message.
 */
export function spadeTaskLine(
  name: string,
  task: SpadeTaskProgress | undefined,
  /** The step's words when the task carries none: the agent's live status. */
  status?: string | undefined,
): SpadeTaskLine | undefined {
  if (!task) return undefined;
  if (task.state === "blocked_on_person")
    return { sentence: `${name} needs you`, step: undefined, tone: "needs-you" };
  if (task.state === "waiting")
    return { sentence: `${name} is waiting`, step: task.step, tone: "waiting" };
  if (task.continuing && task.state !== "done")
    return {
      sentence: `${name} is working on it`,
      step: status === "Checking a step" ? status : (task.step ?? status),
      tone: "working",
    };
  return undefined;
}
