import { z } from "zod";

/*
 * Whether a bot is still on its task. Every bot is on the auto-review (ADR 0163): a review model
 * approves or refuses its steps, and the person is asked only when it retries a refused step or
 * the review can't run, so there is no level to show or choose. A bot keeps working until its
 * task is done; while it does, Spade says so (`continuing`), and a task waiting on the person is
 * `blocked_on_person`. Parsed leniently: a value this client doesn't know reads as unknown.
 */

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
