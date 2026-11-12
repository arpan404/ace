import type { Interaction, Item } from "@ace/protocol";
import { agentOutcome } from "./agent-prs.ts";
import { agentStep } from "./agent-step.ts";
import { foldWords, type AgentForestNode, type ThreadWork } from "./agent-forest.ts";
import { isRunning } from "./agents.ts";
import { pluralCount } from "./counts.ts";
import { remoteContactStep } from "./remote-contact.ts";
import { askWords } from "./summary-now.ts";
import { formatSpan } from "./time.ts";

/*
 * One agent row of the Summary's tree (ADR 0108) in words: what it is doing, in the warning colour
 * when it asks the person and red when it failed, what a folded branch holds, how long it ran,
 * and how its provider mark reads (breathing while live, dimmed once done, still while its facts
 * are stale). The web's tree and the phone's draw from this. Pure: the clock is passed in.
 */

/** Each thread's oldest pending request by `thread/agent`, as the tree's rows look them up. */
export function forestRequests(works: ReadonlyMap<string, ThreadWork>): Map<string, Interaction> {
  const requests = new Map<string, Interaction>();
  for (const [threadId, work] of works)
    for (const interaction of work.interactions) {
      const key = `${threadId}/${interaction.agentId}`;
      if (!requests.has(key)) requests.set(key, interaction);
    }
  return requests;
}

/** The request a row speaks for: its own, or for a delegate, its thread's main agent's. */
export function rowRequest(
  node: AgentForestNode,
  requests: ReadonlyMap<string, Interaction>,
): Interaction | undefined {
  return (
    requests.get(node.key) ??
    (node.childThread && node.childRoot
      ? requests.get(`${node.childThread}/${node.childRoot.id}`)
      : undefined)
  );
}

/**
 * The item a row's step reads from: the tool its doer is running, in the thread the doer lives
 * in (a delegate's work is its thread's main agent's). Undefined while it runs none.
 */
export function rowStepItem(
  node: AgentForestNode,
): { threadId: string; itemId: string } | undefined {
  const status = (node.childRoot ?? node.agent).status;
  if (status.state !== "working" || !status.itemId) return undefined;
  const threadId = node.childRoot ? node.childThread : node.threadId;
  return threadId ? { threadId, itemId: status.itemId } : undefined;
}

export interface SummaryRowFacts {
  node: AgentForestNode;
  /** The thread the Summary shows: its own main agent opens nothing and isn't stopped alone. */
  viewed: string;
  request: Interaction | undefined;
  /** The item `rowStepItem` names, once loaded. */
  tool: Item | undefined;
  /** The call that started the agent, whose report says how it ended. */
  spawn: Item | undefined;
  /** The connection to the daemon is current. */
  fresh: boolean;
  /** Has children: whether they show. */
  expanded: boolean | undefined;
  now: number;
}

export interface SummaryRow {
  /** The viewed thread's main agent: it is the tree itself, opening nothing. */
  root: boolean;
  step: string;
  tone: "needs-you" | "failed" | undefined;
  /** What a folded branch holds ("2 working · 3 done"); empty when it shows or says enough. */
  folded: string;
  /** How long it ran, or has run while live; empty under a second. */
  time: string;
  /** Settled and sure of it: the mark dims and the name steps back. */
  done: boolean;
  /** The name steps back: done, or settled-looking while it isn't sure. */
  muted: boolean;
  /** The mark holds still: its facts are stale or unconfirmed. */
  still: boolean;
  /** Its own turn runs (not only work under it), so it can be stopped on its own. */
  own: boolean;
}

export function summaryRow(facts: SummaryRowFacts): SummaryRow {
  const { node, request } = facts;
  const { agent } = node;
  // A delegate's own work is its thread's main agent's: its step reads from there once loaded.
  const doer = node.childRoot ?? agent;
  const status = doer.status;
  const root = agent.origin === "root" && node.threadId === facts.viewed;
  const asks = request ? askWords(request.request) : undefined;
  const own = isRunning(doer);
  const below = node.tally;
  const asking = request !== undefined || (status.state === "blocked" && status.on === "human");
  const tone = asking ? "needs-you" : status.state === "failed" ? "failed" : undefined;
  // A child on another machine that lost contact or didn't confirm its stop says so (ADR 0052).
  const contact = node.live ? undefined : remoteContactStep(agent);
  const current = contact
    ? contact
    : request
      ? asks
        ? `asks: ${asks}`
        : agentStep({ status, interaction: request })
      : status.state === "failed"
        ? // Its own words are in its view; a raw provider error doesn't belong in the tree.
          "couldn't finish"
        : own && node.live
          ? agentStep({ status, item: facts.tool })
          : node.live
            ? below.working || below.commands
              ? `waiting on ${pluralCount(below.working + below.commands, below.working ? "agent" : "command")}`
              : agentStep({ status, item: facts.tool })
            : (agentOutcome(facts.spawn) ?? "finished");
  // Facts not confirmed since the connection dropped or the Summary opened: what it was doing
  // when last seen, and never "finished" for a branch that may be working again.
  const stale = !facts.fresh || node.stale;
  // Settled-looking while something under it isn't confirmed or couldn't load: it may still be
  // working, so it reads neither finished nor done. A failure or a request is known for sure.
  const uncertain =
    !node.live && node.unconfirmed && !stale && status.state !== "failed" && !request;
  const unsure = node.live ? `last seen ${current}` : "syncing";
  // An unloaded delegate says only "not loaded": that is why it isn't sure.
  const seen = stale ? unsure : !uncertain ? current : node.notLoaded ? "" : "syncing";
  const step = node.notLoaded ? (seen ? `${seen} · not loaded` : "not loaded") : seen;
  // A settled-looking row that isn't sure already says so; its fold adds nothing to that.
  const settledLook = !node.live && (stale || uncertain);
  const folded = facts.expanded === false && !settledLook ? foldWords(below) : "";
  const end = agent.endedAt ?? (node.live ? Math.max(facts.now, agent.createdAt) : undefined);
  const time =
    end !== undefined && end - agent.createdAt >= 1000 ? formatSpan(agent.createdAt, end) : "";
  const done = !node.live && !stale && !uncertain;
  return {
    root,
    step,
    tone,
    folded,
    time,
    done,
    muted: done || settledLook,
    still: stale || uncertain,
    own,
  };
}
