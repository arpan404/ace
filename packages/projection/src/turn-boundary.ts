import type { Item, MessageOrigin, RunTrigger } from "@ace/protocol";

/**
 * Inputs that carry the current ask on rather than asking something new: an agent's own result
 * coming back, its background work finishing, the person answering the agent's question, ace
 * continuing interrupted work, and a provider handoff's context. They join the current turn.
 */
const carriesOn = new Set<MessageOrigin["kind"]>([
  "subagent_result",
  "background_completion",
  "interaction_answer",
  "restart",
  "limit_resume",
  "handoff",
]);

/**
 * Whether a root user-role message opens a new turn (ADR 0062): the person's own words (typed,
 * queued or steered), a scheduled or automation prompt, a parent agent's ask in a child thread,
 * and a provider-native user message with no origin. Every other origin joins the current turn.
 * The caller checks the message belongs to the root agent.
 */
export function startsTurn(item: Item): boolean {
  if (item.type !== "message" || item.role !== "user") return false;
  return item.origin === undefined || !carriesOn.has(item.origin.kind);
}

/**
 * Run triggers that say someone asked for the run: the person (typed or queued, including in the
 * provider's own CLI, which ace sees only as the run), a parent agent's ask in a child thread,
 * and a schedule. Agent-started runs (`background_completion`, `subagent_result`), ace carrying
 * on (`restart`, `limit_resume`) and `unknown` ask nothing by themselves.
 */
const askingTriggers = new Set<RunTrigger>([
  "user",
  "queue",
  "spawn",
  "parent_agent",
  "goal",
  "schedule",
]);

/**
 * The turn a new root run joins when it starts (a run keeps the turn it was given). The first run
 * opens turn 1 (or the one after a pre-turn thread's last run); after that a run opens the next
 * turn only when an ask is waiting for it (`asked`) or its trigger says it was asked for, else it
 * joins the current turn.
 */
export function startedRunTurn(facts: {
  current: number | undefined;
  legacyBase: number;
  asked: boolean;
  trigger: RunTrigger;
}): number {
  if (facts.current === undefined || facts.current < 1) return facts.legacyBase + 1;
  return facts.asked || askingTriggers.has(facts.trigger) ? facts.current + 1 : facts.current;
}

/** A root run's turn: runs recorded before turns were numbered fall back to their ordinal. */
export function runTurn(run: { turn?: number | undefined; ordinal?: number | undefined }) {
  return run.turn ?? run.ordinal;
}
