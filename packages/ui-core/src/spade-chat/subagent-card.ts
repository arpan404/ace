import { pluralCount } from "../counts.ts";
import { subagentRunning } from "../subagent-row.ts";
import { subagentTerminal, type SubagentState } from "../subagents.ts";
import { formatSpan } from "../time.ts";
import { spadeAskingWords } from "./delegations.ts";
import { spadeWorkingPhrase, spadeWorkingWord } from "./working-phrase.ts";

/*
 * The subagent card: the ace agents and bots one call of a bot started (ADR 0161), drawn the
 * Spade way, as every client shows it. Its first line is one sentence about the bot and its
 * agents; under it, one row per agent with its state in words, what it does now and how long it
 * has run. One that waits on the person is never folded away. Nothing here says finished while
 * any agent still works or waits on the person (AGENTS.md priority 1). Pure.
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
  human: "Waiting for you",
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
  /** An ace agent's step or last line, as ace says it for a delegated child. */
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

/**
 * What the agent does now (the short Working phrase), or for one that ended what it found or why
 * it failed. Undefined when there is nothing beyond its state: one waiting on the person says
 * what for in its state, and a bare "Working" would only repeat it.
 */
export function spadeSubagentStep(facts: SpadeSubagentFacts): string | undefined {
  if (facts.state === "human") return undefined;
  const said = facts.kind === "bot" ? facts.status : facts.detail;
  if (subagentTerminal(facts.state)) return facts.kind === "ace" ? said || undefined : undefined;
  if (!subagentRunning(facts.state)) return undefined;
  const phrase = spadeWorkingPhrase(said);
  return phrase === spadeWorkingWord ? undefined : phrase;
}

/**
 * The card's first line: "Quill is working with 4 agents" while any agent works or waits on the
 * person, or while what the card reads isn't current; "Quill worked with 4 agents · 12m" once
 * every one has ended, with how long they took when that is known.
 */
export function spadeSubagentHeader(
  bot: string,
  states: readonly SubagentState[],
  options: { current: boolean; span?: { startedAt: number; endedAt: number } | undefined },
): string {
  const count = pluralCount(states.length, "agent");
  const ended = options.current && states.length > 0 && states.every(subagentTerminal);
  if (!ended) return `${bot} is working with ${count}`;
  const span = options.span;
  // Under a second says nothing: a span only the clock's grain could measure.
  const took =
    span && span.endedAt - span.startedAt >= 1000
      ? ` · ${formatSpan(span.startedAt, span.endedAt)}`
      : "";
  return `${bot} worked with ${count}${took}`;
}

/** From the first start to the last end, once every agent has an end; else undefined. */
export function spadeSubagentsSpan(
  agents: readonly { startedAt?: number | undefined; endedAt?: number | undefined }[],
): { startedAt: number; endedAt: number } | undefined {
  let startedAt = Infinity;
  let endedAt = -Infinity;
  for (const agent of agents) {
    if (agent.startedAt === undefined || agent.endedAt === undefined) return undefined;
    startedAt = Math.min(startedAt, agent.startedAt);
    endedAt = Math.max(endedAt, agent.endedAt);
  }
  return agents.length > 0 && endedAt >= startedAt ? { startedAt, endedAt } : undefined;
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
