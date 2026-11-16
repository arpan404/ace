import type { Interaction, Item } from "@ace/protocol";
import {
  agentOutcome,
  agentStep,
  askWords,
  isRunning,
  nowLine,
  pluralCount,
  remoteContactStep,
  type AgentForestNode,
  type NowFacts,
  type NowLine,
} from "@ace/ui-core";
import type { Live } from "@/lib/live-connection.ts";

/*
 * Every word and tone the Summary derives from a thread's or an agent's state comes from here.
 * Each takes `live` first, required, and returns the stale presentation before reading any
 * state while the copy isn't current. The `ace/live-actions` lint rule keeps the ui-core
 * formatters these wrap to files named live-words.ts.
 */

/**
 * Now: who needs the person and what they ask, what works and for how long, or how it ended.
 * While not current, only the stale words: no tone, no span, no second line.
 */
export function summaryNow(live: Live, facts: NowFacts): NowLine {
  if (!live.current)
    return { say: live.word, speak: live.word, lead: live.word, sub: "", tone: "plain" };
  return nowLine(facts);
}

/** What one agent row in the Summary says and how it reads. */
export interface AgentRowWords {
  /** "asks: which branch", "running bun test", "last seen running bun test", "syncing". */
  step: string;
  tone: "needs-you" | "failed" | undefined;
  /** Settled and sure: reads done. */
  done: boolean;
  /** Its mark says it isn't sure (stale, or something under it unconfirmed). */
  unsure: boolean;
  /** Settled-looking but not sure: its fold adds nothing to that. */
  settledLook: boolean;
}

/** What the agent is doing, from facts known current. */
function currentStep(
  node: AgentForestNode,
  request: Interaction | undefined,
  tool: Item | undefined,
  spawn: Item | undefined,
): string {
  const doer = node.childRoot ?? node.agent;
  const { status } = doer;
  const contact = node.live ? undefined : remoteContactStep(node.agent);
  if (contact) return contact;
  if (request) {
    const asks = askWords(request.request);
    return asks ? `asks: ${asks}` : agentStep({ status, interaction: request });
  }
  // Its own words are in its view; a raw provider error doesn't belong in the tree.
  if (status.state === "failed") return "couldn't finish";
  const below = node.tally;
  if (node.live && !isRunning(doer) && (below.working || below.commands))
    return `waiting on ${pluralCount(below.working + below.commands, below.working ? "agent" : "command")}`;
  if (node.live) return agentStep({ status, item: tool });
  return agentOutcome(spawn) ?? "finished";
}

/**
 * One agent row's words. Not current (its thread's copy, or the facts under it): no tone and
 * never "finished" for a branch that may be working again; a live one says what it was doing
 * when last seen, a settled one only "syncing".
 */
export function agentRowWords(
  live: Live,
  node: AgentForestNode,
  facts: { request: Interaction | undefined; tool: Item | undefined; spawn: Item | undefined },
): AgentRowWords {
  const withLoad = (seen: string) =>
    node.notLoaded ? (seen ? `${seen} · not loaded` : "not loaded") : seen;
  if (!live.current || node.stale) {
    const seen = node.live
      ? `last seen ${currentStep(node, facts.request, facts.tool, facts.spawn)}`
      : "syncing";
    return {
      step: withLoad(seen),
      tone: undefined,
      done: false,
      unsure: true,
      settledLook: !node.live,
    };
  }
  const { status } = node.childRoot ?? node.agent;
  const asking =
    facts.request !== undefined || (status.state === "blocked" && status.on === "human");
  const tone = asking ? "needs-you" : status.state === "failed" ? "failed" : undefined;
  // Settled-looking while something under it isn't confirmed or couldn't load: it may still be
  // working, so it reads neither finished nor done. A failure or a request is known for sure.
  const uncertain = !node.live && node.unconfirmed && status.state !== "failed" && !facts.request;
  const current = currentStep(node, facts.request, facts.tool, facts.spawn);
  // An unloaded delegate says only "not loaded": that is why it isn't sure.
  const seen = !uncertain ? current : node.notLoaded ? "" : "syncing";
  return {
    step: withLoad(seen),
    tone,
    done: !node.live && !uncertain,
    unsure: uncertain,
    settledLook: !node.live && uncertain,
  };
}
