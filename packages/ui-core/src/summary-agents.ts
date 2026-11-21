import type { Interaction, Item } from "@ace/protocol";
import type { AgentForest, AgentForestNode, ForestNode, ThreadWork } from "./agent-forest.ts";
import { agentOutcome } from "./agent-prs.ts";
import { agentStep } from "./agent-step.ts";
import { isRunning } from "./agents.ts";
import { pluralCount } from "./counts.ts";
import { remoteContactStep } from "./remote-contact.ts";
import { forestRequest, forestRequests } from "./forest-requests.ts";
import { askWords } from "./summary-now.ts";

/*
 * The Summary's agents, as words and as groups. `forestAgentWords` is what one agent row says
 * (the web's tree and the phone's groups read the same words); `summaryAgents` sorts the tree
 * for a phone: who waits on the person first, then what works, what failed, and what finished.
 * Pure: the forest is built by `agentForest`, which already keeps every branch with live work
 * under it out of done.
 */

/** What one agent row's words are read from, besides the node. */
export interface ForestRowFacts {
  /** The request the person can answer for it, its own or its delegated thread's main agent's. */
  request: Interaction | undefined;
  /** The tool call its status points at, when loaded. */
  tool: Item | undefined;
  /** The call that started it, for what it came back with. */
  spawn: Item | undefined;
}

/** What one agent row in the Summary says and how it reads. */
export interface ForestAgentWords {
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
function currentStep(node: AgentForestNode, facts: ForestRowFacts): string {
  const doer = node.childRoot ?? node.agent;
  const { status } = doer;
  const contact = node.live ? undefined : remoteContactStep(node.agent);
  if (contact) return contact;
  if (facts.request) {
    const asks = askWords(facts.request.request);
    return asks ? `asks: ${asks}` : agentStep({ status, interaction: facts.request });
  }
  // Its own words are in its view; a raw provider error doesn't belong in the tree.
  if (status.state === "failed") return "couldn't finish";
  const below = node.tally;
  if (node.live && !isRunning(doer) && (below.working || below.commands))
    return `waiting on ${pluralCount(below.working + below.commands, below.working ? "agent" : "command")}`;
  // Its thread shows under another row, still working: this row waits on it there.
  if (node.live && !isRunning(doer) && node.elsewhere) return "waiting on delegated work";
  // Live while its own status says it ended (a hold still running, a delegated thread still
  // going): the row's state is the tree's, so it says it works, never its own "done".
  if (node.live) return isRunning(doer) ? agentStep({ status, item: facts.tool }) : "working";
  return agentOutcome(facts.spawn) ?? "finished";
}

/**
 * One agent row's words. Not current (`current` false for the copy, or the node's own facts
 * stale): no tone and never "finished" for a branch that may be working again; a live one says
 * what it was doing when last seen, a settled one only "syncing".
 */
export function forestAgentWords(
  current: boolean,
  node: AgentForestNode,
  facts: ForestRowFacts,
): ForestAgentWords {
  const withLoad = (seen: string) =>
    node.notLoaded ? (seen ? `${seen} · not loaded` : "not loaded") : seen;
  if (!current || node.stale) {
    const seen = node.live ? `last seen ${currentStep(node, facts)}` : "syncing";
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
  const step = currentStep(node, facts);
  // A remote child in doubt says why in its own words; an unloaded delegate says only "not
  // loaded". Either is why it isn't sure.
  const contact = node.live ? undefined : remoteContactStep(node.agent);
  const seen = !uncertain ? step : (contact ?? (node.notLoaded ? "" : "syncing"));
  return {
    step: withLoad(seen),
    tone,
    done: !node.live && !uncertain,
    unsure: uncertain,
    settledLook: !node.live && uncertain,
  };
}

export type SummaryAgentGroup = "asks" | "working" | "failed" | "done";

export interface SummaryAgentEntry {
  node: AgentForestNode;
  group: SummaryAgentGroup;
  /** The request it waits on the person for, when there is one. */
  request: Interaction | undefined;
  /** Levels in under the agents above it that sit in the same group, at most `maxIndent`. */
  indent: number;
  /**
   * The agent it hangs under, when the indent doesn't show it: that agent is in another group,
   * or the indent stopped at its limit. Never the thread's main agent.
   */
  under: AgentForestNode | undefined;
}

export interface SummaryAgents {
  asks: SummaryAgentEntry[];
  working: SummaryAgentEntry[];
  failed: SummaryAgentEntry[];
  done: SummaryAgentEntry[];
  /** Every agent listed. */
  total: number;
  /** Those in `done`. */
  finished: number;
}

/** How far rows indent at phone width before they name their parent instead. */
export const summaryIndentLimit = 2;

const troubled = (node: AgentForestNode) => {
  const state = (node.childRoot ?? node.agent).status.state;
  return state === "failed" || state === "unresponsive";
};

function groupOf(node: AgentForestNode, request: Interaction | undefined): SummaryAgentGroup {
  const { status } = node.childRoot ?? node.agent;
  // A request on a copy that isn't current may already be answered: it waits with the rest.
  if (!node.stale && (request || (status.state === "blocked" && status.on === "human")))
    return "asks";
  // Live work under it, or facts not confirmed: never done.
  if (node.live || node.stale) return "working";
  if (troubled(node)) return "failed";
  if (node.unconfirmed) return "working";
  return "done";
}

/**
 * The tree for a phone's Summary: every agent but the thread's own main agent (the page is
 * that agent), sorted into who waits on the person, what works, what failed and what finished,
 * each in tree order. A row indents under agents above it in its own group, up to
 * `summaryIndentLimit`; past that, or when its parent sits in another group, it names its parent.
 * Undefined when there is no agent besides the main one.
 */
export function summaryAgents(
  threadId: string,
  forest: Pick<AgentForest, "roots">,
  works: ReadonlyMap<string, Pick<ThreadWork, "agents" | "interactions" | "facts">>,
): SummaryAgents | undefined {
  const requests = forestRequests(works);
  const lists: Record<SummaryAgentGroup, SummaryAgentEntry[]> = {
    asks: [],
    working: [],
    failed: [],
    done: [],
  };
  /** The listed agents above the one being placed, with the group each went to. */
  const above: { node: AgentForestNode; group: SummaryAgentGroup }[] = [];
  /** How many of `above` sit in each group, kept as the walk goes down and back up. */
  const inGroup: Record<SummaryAgentGroup, number> = { asks: 0, working: 0, failed: 0, done: 0 };
  const visit = (node: ForestNode) => {
    if (node.kind !== "agent") return;
    const request = forestRequest(node, requests);
    const group = groupOf(node, request);
    const parent = above.at(-1);
    const same = inGroup[group];
    const indent = Math.min(same, summaryIndentLimit);
    const shown = parent !== undefined && parent.group === group && same <= summaryIndentLimit;
    lists[group].push({
      node,
      group,
      request,
      indent,
      under: parent && !shown ? parent.node : undefined,
    });
    above.push({ node, group });
    inGroup[group]++;
    for (const child of node.children) visit(child);
    inGroup[group]--;
    above.pop();
  };
  for (const root of forest.roots) {
    const main =
      root.kind === "agent" && root.threadId === threadId && root.agent.origin === "root";
    if (main) for (const child of root.children) visit(child);
    else visit(root);
  }
  const total = lists.asks.length + lists.working.length + lists.failed.length + lists.done.length;
  if (!total) return undefined;
  return { ...lists, total, finished: lists.done.length };
}
