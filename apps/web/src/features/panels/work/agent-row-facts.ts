import {
  agentGlyph,
  agentOutcome,
  backgroundCommand,
  agentStep,
  askWords,
  foldWords,
  formatSpan,
  glyphOf,
  isRunning,
  pluralCount,
  remoteContactStep,
  type AgentForestNode,
  type CommandForestNode,
  type GlyphState,
  type ThreadWork,
} from "@ace/ui-core";
import { useItem, useThreadMeta } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { useNow } from "@/lib/time.ts";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useAgentDetails } from "../agents/agent-details.ts";
import { useAgentIdentity } from "../agents/agent-identity.ts";

/**
 * What one agent's Summary row says, shared by the agent tree and Still running: its name, what
 * it is doing (its ask in the needs-you colour, "couldn't finish" in red, "syncing" or "last seen
 * …" while its facts aren't current), how long it has run, and what a click opens.
 */
export function useAgentRowFacts(props: {
  node: AgentForestNode;
  /** The thread the Summary shows: its own main agent opens nothing. */
  viewed: string;
  request: Interaction | undefined;
  /** Its children are folded away: the step adds what the branch holds. */
  folded: boolean;
}) {
  const { node } = props;
  const { agent } = node;
  const thread = useThreadMeta(node.threadId);
  const identity = useAgentIdentity(node.threadId, agent);
  const details = useAgentDetails(thread, agent);
  // A delegate's own work is its thread's main agent's: its step reads from there once loaded.
  const doer = node.childRoot ?? agent;
  const status = doer.status;
  const tool = useItem(
    node.childRoot ? node.childThread : node.threadId,
    status.state === "working" && status.itemId ? status.itemId : "",
  );
  const openSubagent = useOpenSubagent();
  const now = useNow();
  const root = agent.origin === "root" && node.threadId === props.viewed;
  const asks = props.request ? askWords(props.request.request) : undefined;
  const own = isRunning(doer);
  const below = node.tally;
  const asking =
    props.request !== undefined || (status.state === "blocked" && status.on === "human");
  const tone = asking ? "needs-you" : status.state === "failed" ? "failed" : undefined;
  // A child on another machine that lost contact or didn't confirm its stop says so (ADR 0052).
  const contact = node.live ? undefined : remoteContactStep(agent);
  const current = contact
    ? contact
    : props.request
      ? asks
        ? `asks: ${asks}`
        : agentStep({ status, interaction: props.request })
      : status.state === "failed"
        ? // Its own words are in its view; a raw provider error doesn't belong in the tree.
          "couldn't finish"
        : own && node.live
          ? agentStep({ status, item: tool })
          : node.live
            ? below.working || below.commands
              ? `waiting on ${pluralCount(below.working + below.commands, below.working ? "agent" : "command")}`
              : agentStep({ status, item: tool })
            : (agentOutcome(identity.spawn) ?? "finished");
  const fresh = useLiveConnection().fresh;
  // Facts not confirmed since the connection dropped or the Summary opened: what it was doing
  // when last seen, and never "finished" for a branch that may be working again.
  const stale = !fresh || node.stale;
  // Settled-looking while something under it isn't confirmed or couldn't load: it may still be
  // working, so it reads neither finished nor done. A failure or a request is known for sure.
  const uncertain =
    !node.live && node.unconfirmed && !stale && status.state !== "failed" && !props.request;
  const unsure = node.live ? `last seen ${current}` : "syncing";
  // An unloaded delegate says only "not loaded": that is why it isn't sure.
  const seen = stale ? unsure : !uncertain ? current : node.notLoaded ? "" : "syncing";
  const step = node.notLoaded ? (seen ? `${seen} · not loaded` : "not loaded") : seen;
  // A settled-looking row that isn't sure already says so; its fold adds nothing to that.
  const settledLook = !node.live && (stale || uncertain);
  const folded = props.folded && !settledLook ? foldWords(below) : "";
  const end = agent.endedAt ?? (node.live ? Math.max(now, agent.createdAt) : undefined);
  const time =
    end !== undefined && end - agent.createdAt >= 1000 ? formatSpan(agent.createdAt, end) : "";
  const open = root
    ? undefined
    : () =>
        openSubagent({
          threadId: node.threadId,
          agentId: agent.id,
          // A child on another machine has no thread here: it opens as its parent's agent.
          childThreadId: agent.machine ? undefined : agent.childThreadId,
        });
  const name = identity.name;
  const done = !node.live && !stale && !uncertain;
  // Its own run's state; an agent whose turn ended waits on what runs under it.
  const glyph: GlyphState = asking ? "needs-you" : own ? agentGlyph(glyphOf(status)) : "subagents";
  return {
    glyph,
    name,
    step,
    tone,
    asking,
    folded,
    time,
    open,
    root,
    own,
    done,
    stale,
    uncertain,
    settledLook,
    details,
    title: [name, ...details.lines].filter(Boolean).join("\n"),
    label: `${name}${agent.machine ? ` · ${agent.machine.name}` : ""}: ${step}${folded ? ` · ${folded}` : ""}`,
  };
}

/**
 * What a running background command's row says: the command, "running" (or "last seen running"
 * while its facts aren't current), how long it has run, and, in the viewed thread, its output.
 */
export function useCommandRowFacts(node: CommandForestNode, viewed: string) {
  const { task } = node;
  const item = useItem(node.threadId, task.toolCallId ?? "");
  const workspace = useWorkspaceActions(viewed);
  const now = useNow();
  const command = backgroundCommand(task, item);
  const fresh = useLiveConnection().fresh && !node.unconfirmed;
  const end = Math.max(now, task.startedAt);
  // Its output opens in this thread's terminal; a delegated thread's opens there.
  const open =
    node.threadId === viewed ? () => workspace.open({ kind: "shell", id: task.id }) : undefined;
  return {
    command,
    fresh,
    open,
    time: end - task.startedAt >= 1000 ? formatSpan(task.startedAt, end) : "",
    label: `$ ${command}: ${fresh ? "running" : "last seen running"}`,
  };
}

/** Each agent's first pending request across the forest's threads, by `thread/agent`. */
export function forestRequests(works: ReadonlyMap<string, ThreadWork>) {
  const map = new Map<string, Interaction>();
  for (const [threadId, work] of works)
    for (const interaction of work.interactions) {
      const key = `${threadId}/${interaction.agentId}`;
      if (!map.has(key)) map.set(key, interaction);
    }
  return map;
}

/** The request a row waits on: its own, or for a delegate, its thread's main agent's. */
export function requestFor(
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
