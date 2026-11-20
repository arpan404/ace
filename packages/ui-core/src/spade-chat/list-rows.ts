import type { SpadeAgent } from "./agents.ts";
import { spadeTaskLine } from "./autonomy.ts";
import { parseSpadeGoalProgress, spadeGoalLine } from "./goal.ts";
import { spadeGroupLine, type SpadeGroup } from "./groups.ts";
import { spadeForLaterWords } from "./questions.ts";
import { spadeProblemStep } from "./request-words.ts";
import { spadeMoveLine } from "./moves.ts";

/*
 * What Spade's list says about each conversation (docs/design/spade.md §2): its state, which
 * picks the face's pose, its dot and its line's colour; its one line; and where it sits. Spade
 * sends each latest message as a plain-text preview and says which conversations finished
 * unseen (its seen cursor). Every client's list rows come from here.
 */

/** Where a listed bot or group runs, and whether its Spade answers now. */
export interface SpadeRowPlace {
  machine: { primary: boolean; name: string };
  /** Its machine is offline: listed from its last answer. */
  away: boolean;
  /** Its machine is online but its Spade doesn't answer: listed from its last answer. */
  unavailable: boolean;
}
export type SpadeRowBot = SpadeAgent & SpadeRowPlace;
export type SpadeRowGroup = SpadeGroup & SpadeRowPlace;

/**
 * A row's state, in the order the list sorts by: needs you, working, failed, finished and not
 * seen, then the rest. `off` (its machine offline or its Spade not running) sorts with the rest.
 */
export type SpadeRowState = "needs-you" | "working" | "failed" | "unseen" | "rest" | "off";

export const spadeRowRank: Record<SpadeRowState, number> = {
  "needs-you": 0,
  working: 1,
  failed: 2,
  unseen: 3,
  rest: 4,
  off: 4,
};

export interface SpadeRow {
  state: SpadeRowState;
  line: string;
}

/** Off here or on the machine named (ace runs on more than Macs); its machine offline says so. */
export function spadeOffLine(entry: {
  away: boolean;
  machine: { primary: boolean; name: string };
}): string {
  if (entry.away) return `${entry.machine.name} is offline`;
  return entry.machine.primary ? "Off on this machine" : `Off on ${entry.machine.name}`;
}

function lastLine(bot: SpadeRowBot): string {
  const last = bot.lastMessage;
  const text = last?.text ?? "";
  if (!last || !text) return "No messages yet";
  if (last.from === "agent") return text;
  return `${last.fromAgent ? last.fromAgent.name : "You"}: ${text}`;
}

/**
 * A bot's row: what needs the person first, then its goal's verified progress, what it does,
 * what broke, else its last word. The goal's words come from the check (ADR 0159), never the
 * bot's own "done"; `notYet` is what the check found missing, when it is known.
 */
export function spadeBotRow(bot: SpadeRowBot, notYet?: string): SpadeRow {
  if (bot.away || bot.unavailable) return { state: "off", line: spadeOffLine(bot) };
  // Moving to another machine (ADR 0187): where to, in the profile's words; a failed move says
  // only that it stayed, the profile says why.
  if (bot.move?.state === "failed")
    return { state: "rest", line: `Couldn't move to ${bot.move.to.name}; still here` };
  if (bot.move) return { state: "rest", line: spadeMoveLine(bot.move, bot.name) };
  if (bot.state === "waiting")
    return {
      state: "needs-you",
      line: bot.waitingFor === "question" ? "Asked you a question" : (bot.status ?? "Needs you"),
    };
  // The person paused it (ADR 0200 §6.1): nothing of it fires until they resume it.
  if (bot.state === "paused") return { state: "rest", line: "Paused" };
  // The person has its computer: Spade pauses it until they hand it back.
  if (bot.computer?.driver === "person")
    return { state: "rest", line: "Paused while you have the computer" };
  // A task it carries on by itself, or one that waits on the person, in its chat's words.
  const task = spadeTaskLine(bot.name, bot.progress, bot.status);
  if (task?.tone === "needs-you") return { state: "needs-you", line: task.step ?? "Needs you" };
  const goal = goalRow(bot, task !== undefined, notYet);
  if (goal) return goal;
  // Waiting on a job, another bot or its next step's time: nothing for the person to do.
  if (task?.tone === "waiting")
    return { state: "rest", line: ["Waiting", task.step].filter(Boolean).join(" · ") };
  if (task) return { state: "working", line: task.step ?? bot.status ?? "Working on it" };
  if (bot.state === "working") return { state: "working", line: bot.status ?? "Working" };
  // A subscription that couldn't run (signed out, out of quota): its next step in a few words.
  if (bot.problem) return { state: "failed", line: spadeProblemStep(bot.problem) };
  const state = bot.unseen ? "unseen" : "rest";
  // Cards left for later wait on nothing: a quiet count, never the needs-you colour (ADR 0154).
  if (bot.questionsForLater > 0) return { state, line: spadeForLaterWords(bot.questionsForLater) };
  return { state, line: lastLine(bot) };
}

/** A bot's row while it has a goal: its verified progress, muted while it works. */
function goalRow(bot: SpadeRowBot, carriesOn: boolean, notYet: string | undefined) {
  const progress = parseSpadeGoalProgress(bot.raw);
  const line = spadeGoalLine(progress, notYet);
  if (!progress || !line) return undefined;
  const working = bot.state === "working" || carriesOn;
  if (progress.state === "done" || progress.state === "unchecked" || !working)
    return { state: bot.unseen ? "unseen" : "rest", line } satisfies SpadeRow;
  return { state: "working", line } satisfies SpadeRow;
}

/** A group's row: what it waits on or does, else its last speaker named, then their words. */
export function spadeGroupRow(group: SpadeRowGroup): SpadeRow {
  if (group.away || group.unavailable) return { state: "off", line: spadeOffLine(group) };
  const said = spadeGroupLine(group);
  if (group.state === "waiting") return { state: "needs-you", line: said.text };
  if (group.state === "working") return { state: "working", line: said.text };
  return { state: group.unseen ? "unseen" : "rest", line: said.text };
}

/** `items` in the list's order: by state (`spadeRowRank`), newest activity first within one. */
export function spadeByState<T>(
  items: readonly T[],
  state: (item: T) => SpadeRowState,
  activity: (item: T) => number,
): T[] {
  return items.toSorted(
    (a, b) => spadeRowRank[state(a)] - spadeRowRank[state(b)] || activity(b) - activity(a),
  );
}
