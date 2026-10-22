import type { ProviderGoal } from "@ace/protocol";
import { pluralCount } from "./counts.ts";
import { goalTitle } from "./goal.ts";
import { timedWords, type TurnActivity } from "./turn-activity.ts";
import { waitWords } from "./wait-words.ts";

/*
 * The phone's live pill: one capsule over the composer that says what the thread is doing now
 * ("Working for 1m 14s") and, beside it, what else is live ("2 subagents", "1 command",
 * "2 queued", "Pursuing goal"). Each part names the sheet it opens. A request needs the person
 * and has the composer's strip to itself, so its words are never the pill's.
 */

/** What a part of the pill opens: the agent tree (with background commands), the queue, the goal. */
export type PillOpens = "agents" | "queue" | "goal";

/** The pill's lead: the thread's own state, with its timer when it has one. */
export interface PillStatus {
  /** The whole words without the time: "Working", "Waiting on 2", "Running 2 commands". */
  label: string;
  /** The words before the timer ("Working for"); empty when there is no timer. */
  lead: string;
  /** The timer's origin in ms since 1970; undefined without a timer. */
  since: number | undefined;
  /** A single background command, drawn as code after the label. */
  code: string | undefined;
  /** The main agent itself works: the words sweep, as a live step's do. */
  live: boolean;
  opens: PillOpens | undefined;
}

export interface PillSegment {
  kind: "subagents" | "commands" | "queue" | "goal";
  label: string;
  opens: PillOpens;
  /** An active goal while the thread works sweeps like the status. */
  live: boolean;
}

export interface LivePill {
  status: PillStatus | undefined;
  segments: PillSegment[];
}

export interface LivePillFacts {
  activity: TurnActivity | undefined;
  /** Messages waiting in the queue for the turn to end. */
  queued: number;
  goal: ProviderGoal | null | undefined;
}

/** "Waiting on 2": the root does nothing itself while its subagents work. */
export function waitingOnLabel(count: number): string {
  return count > 0 ? `Waiting on ${count}` : "Waiting on subagents";
}

function statusOf(activity: TurnActivity | undefined): PillStatus | undefined {
  // A request is the strip's; its words never repeat here.
  if (!activity || activity.tone === "needs-you") return undefined;
  const wait = activity.waitingOn;
  if (wait?.kind === "subagents")
    return {
      label: waitingOnLabel(wait.count),
      lead: "",
      since: undefined,
      code: undefined,
      live: false,
      opens: "agents",
    };
  if (wait?.kind === "background") {
    const words = waitWords(wait);
    return {
      label: words.label,
      lead: "",
      since: undefined,
      code: words.code,
      live: false,
      opens: "agents",
    };
  }
  const working = activity.tone === "working";
  const timed = working && activity.elapsedFrom !== undefined;
  return {
    label: activity.label,
    lead: timed ? timedWords(activity.label) : "",
    since: timed ? activity.elapsedFrom : undefined,
    code: activity.code,
    live: working,
    opens: undefined,
  };
}

function segmentsOf(facts: LivePillFacts, status: PillStatus | undefined): PillSegment[] {
  const { activity, queued, goal } = facts;
  const segments: PillSegment[] = [];
  const wait = activity?.waitingOn;
  // Subagents beside a working root; while the root only waits on them the status names them.
  const subagents = activity && !activity.waitingOnSubagents && !wait ? (activity.subagents ?? 0) : 0;
  if (subagents > 0)
    segments.push({
      kind: "subagents",
      label: pluralCount(subagents, "subagent", "subagents"),
      opens: "agents",
      live: false,
    });
  // Commands beside the work; while the root waits only on commands the status names them.
  const commands =
    wait?.kind === "subagents"
      ? wait.commands
      : wait?.kind === "background"
        ? 0
        : (activity?.backgroundCommands ?? 0);
  if (commands > 0)
    segments.push({
      kind: "commands",
      label: pluralCount(commands, "command", "commands"),
      opens: "agents",
      live: false,
    });
  if (queued > 0)
    segments.push({ kind: "queue", label: `${queued} queued`, opens: "queue", live: false });
  if (goal)
    segments.push({
      kind: "goal",
      label: goalTitle(goal.status),
      opens: "goal",
      live: goal.status === "active" && status?.live === true,
    });
  return segments;
}

/** The pill, or undefined when nothing is live, queued or pursued. */
export function livePill(facts: LivePillFacts): LivePill | undefined {
  const status = statusOf(facts.activity);
  const segments = segmentsOf(facts, status);
  return status || segments.length > 0 ? { status, segments } : undefined;
}
