import type { Interaction, Item } from "@ace/protocol";
import {
  forestAgentWords,
  nowLine,
  type AgentForestNode,
  type ForestAgentWords,
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
export type AgentRowWords = ForestAgentWords;

/**
 * One agent row's words (`forestAgentWords`, the phone's Summary reads the same). Not current:
 * no tone and never "finished" for a branch that may be working again.
 */
export function agentRowWords(
  live: Live,
  node: AgentForestNode,
  facts: { request: Interaction | undefined; tool: Item | undefined; spawn: Item | undefined },
): AgentRowWords {
  return forestAgentWords(live.current, node, facts);
}
