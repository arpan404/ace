import { pluralCount } from "../counts.ts";
import { subagentTerminal, type SubagentState } from "../subagents.ts";
import { spadeAskingWords } from "./delegations.ts";
import { spadeWorkingPhrase } from "./working-phrase.ts";

/*
 * The subagent card: the ace agents and bots one call of a bot started (ADR 0161), drawn the
 * Spade way, as every client shows it. Its first line is one sentence about the bot and its
 * agents, with how long they have run and how many wait on the person; under it, one row per
 * agent with its name in words, a second line that says something (its live step, what it waits
 * for, what it found, why it failed) and its time. One that waits on the person is never folded
 * away. Nothing here says finished while any agent still works or waits on the person
 * (AGENTS.md priority 1). Pure.
 */

/** The most rows the card shows before "and 3 more". */
export const spadeSubagentRowLimit = 5;

/** How a row's state reads: the needs-you hue, the failed hue, at work, or settled and quiet. */
export type SpadeSubagentTone = "needs-you" | "failed" | "working" | "settled";

export function spadeSubagentTone(state: SubagentState): SpadeSubagentTone {
  if (state === "human") return "needs-you";
  if (state === "failed") return "failed";
  return subagentTerminal(state) ? "settled" : "working";
}

/** A row's state in Spade's words. */
const stateWords: Record<SubagentState, string> = {
  working: "Working",
  human: "Needs you",
  waiting: "Waiting",
  queued: "Queued",
  unresponsive: "Not responding",
  failed: "Failed",
  cancelled: "Stopped",
  done: "Done",
};

/** One agent as its row reads it. */
export interface SpadeSubagentFacts {
  kind: "ace" | "bot";
  state: SubagentState;
  /** What an ace agent's open request asks for (`plan_review`, `question`, `approval`). */
  asking?: string | undefined;
  /** A bot's own status line, from its tree. */
  status?: string | undefined;
  /** An ace agent's step, last line or failure, as ace says it for a delegated child. */
  detail?: string | undefined;
}

/**
 * A row's state in words. One waiting on the person says what for: "Waiting for you to approve
 * its plan".
 */
export function spadeSubagentStateWords(facts: SpadeSubagentFacts): string {
  if (facts.state === "human" && facts.kind === "ace") return spadeAskingWords(facts.asking);
  return stateWords[facts.state];
}

/** A row's second line: its words, its colour, and whether it is the live step (it shimmers). */
export interface SpadeSubagentLine {
  text: string;
  tone: SpadeSubagentTone;
  live: boolean;
}

/**
 * A row's second line. Working: the short Working phrase of what it does now, plain "Working"
 * when it says nothing of its own. Waiting on the person: what for. Done: what it found, else
 * "Done". Failed: "Failed" and why. Anything else: its state in words.
 */
export function spadeSubagentLine(facts: SpadeSubagentFacts): SpadeSubagentLine {
  const tone = spadeSubagentTone(facts.state);
  const said = (facts.kind === "bot" ? facts.status : facts.detail)?.trim() || undefined;
  switch (facts.state) {
    case "working":
      return { text: spadeWorkingPhrase(said), tone, live: true };
    case "failed":
      return { text: said ? `Failed · ${said}` : "Failed", tone, live: false };
    case "done":
      // A bot's last status is what it was doing, not what it found.
      return { text: (facts.kind === "ace" ? said : undefined) ?? "Done", tone, live: false };
    default:
      return { text: spadeSubagentStateWords(facts), tone, live: false };
  }
}

/**
 * An agent's name as words, not a slug: the bot's own name dropped from its front when the card
 * already says whose agents they are ("Research-pricing" under Research reads "Pricing"),
 * dashes and underscores as spaces, sentence case. The title as it is when nothing is left.
 */
export function spadeSubagentName(title: string, bot: string): string {
  const trimmed = title.trim();
  const prefix = bot.trim().toLowerCase();
  let name = trimmed;
  const rest = trimmed.slice(prefix.length);
  if (prefix && trimmed.toLowerCase().startsWith(prefix) && /^[-_:\s]+\S/.test(rest))
    name = rest.replace(/^[-_:\s]+/, "");
  name = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return title;
  // A slug's words are lower case; words a person wrote keep their capitals.
  const words = /\s/.test(trimmed) ? name : name.toLowerCase();
  return (words[0]?.toUpperCase() ?? "") + words.slice(1);
}

/** "1 needs you": how many agents wait on the person, for the card's first line. */
export function spadeSubagentsNeedYou(states: readonly SubagentState[]): string | undefined {
  const count = states.filter((state) => state === "human").length;
  return count > 0 ? `${count} needs you` : undefined;
}

/**
 * The card's first line: "Quill is working with 4 agents" while any agent works or waits on the
 * person, or while what the card reads isn't current; "Quill worked with 4 agents" once every one
 * has ended. How long they took sits beside it as a time, not in the sentence.
 */
export function spadeSubagentHeader(
  bot: string,
  states: readonly SubagentState[],
  options: { current: boolean },
): string {
  const count = pluralCount(states.length, "agent");
  const ended = options.current && states.length > 0 && states.every(subagentTerminal);
  return ended ? `${bot} worked with ${count}` : `${bot} is working with ${count}`;
}

/**
 * How long the agents have run together: from the first start, to the last end once every one
 * has an end (`endedAt` undefined until then). Undefined when no start is known.
 */
export function spadeSubagentsSpan(
  agents: readonly { startedAt?: number | undefined; endedAt?: number | undefined }[],
): { startedAt: number; endedAt: number | undefined } | undefined {
  let startedAt = Infinity;
  let endedAt: number | undefined = -Infinity;
  for (const agent of agents) {
    if (agent.startedAt !== undefined) startedAt = Math.min(startedAt, agent.startedAt);
    endedAt =
      agent.endedAt === undefined || endedAt === undefined
        ? undefined
        : Math.max(endedAt, agent.endedAt);
  }
  if (startedAt === Infinity) return undefined;
  return {
    startedAt,
    endedAt: endedAt !== undefined && endedAt >= startedAt ? endedAt : undefined,
  };
}

/**
 * Which rows show, by place, and how many are folded into "and 3 more": every row while `open`
 * or while there are at most `limit`; else the first `limit`, where one waiting on the person
 * always shows and takes a place before those that don't. Rows keep their order.
 */
export function spadeShownSubagents(
  states: readonly SubagentState[],
  open: boolean,
  limit: number = spadeSubagentRowLimit,
): { shown: number[]; hidden: number } {
  const all = states.map((_, at) => at);
  if (open || states.length <= limit) return { shown: all, hidden: 0 };
  const needs = all.filter((at) => states[at] === "human");
  const rest = all.filter((at) => states[at] !== "human");
  const kept = new Set([...needs, ...rest.slice(0, Math.max(0, limit - needs.length))]);
  const shown = all.filter((at) => kept.has(at));
  return { shown, hidden: states.length - shown.length };
}
