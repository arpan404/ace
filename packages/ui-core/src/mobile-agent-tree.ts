import { isActionableInteraction } from "@ace/core/human";
import type { Agent, BackgroundTask, Interaction } from "@ace/protocol";
import { firstLine } from "./line-text.ts";
import { syncingWord } from "./row-attention.ts";
import { formatClock } from "./time.ts";
import type { StatusToken } from "./mobile-status.ts";

/*
 * The phone's agent tree (Agents page): each node's status icon and the one line that says why
 * it stopped, and the sentence over the whole tree. Pure: the facts come from one thread's
 * reader, the tree-aware sets from `agentTreeWork`. The sentence never says finished while any
 * branch works or waits, nor while the daemon hasn't confirmed what the phone holds.
 */

/** A node's status icon, in the inbox row's set (`RowStatusIcon` on iOS); null draws none. */
export interface AgentNodeIcon {
  /** approve · question · failed · working · agents · waiting · limited · done, or null. */
  kind: string | null;
  /** needs-you · failed · working · waiting · finished · muted. */
  tone: string;
  /** Subagents a waiting node waits on, drawn inside its ring. */
  count: number | null;
}

export interface AgentTreeSummary {
  /** "Waiting on 2 agents. One needs you." */
  text: string;
  token: StatusToken;
}

type Work = { running: ReadonlySet<string>; needsYou: ReadonlySet<string> };

const none: AgentNodeIcon = { kind: null, tone: "muted", count: null };

/** The person's own requests from this agent, oldest first: what its inline actions answer. */
export function ownRequests(agent: Agent, pending: readonly Interaction[]): Interaction[] {
  return pending.filter(
    (interaction) =>
      interaction.agentId === agent.id && isActionableInteraction(interaction, agent.status),
  );
}

const limited = (agent: Agent) =>
  agent.status.state === "blocked" && agent.status.on === "rate_limit";

/**
 * The node's icon. A node that waits only on what runs under it shows the ring with their
 * count; one whose branch needs the person shows that, even when the request is a child's.
 */
export function agentNodeIcon(
  agent: Agent,
  work: Work,
  /** The oldest request this node's branch waits on the person for: its own, or one below it. */
  asked: Interaction | undefined,
  runningChildren: number,
  fresh: boolean,
): AgentNodeIcon {
  const running = work.running.has(agent.id);
  if (work.needsYou.has(agent.id)) {
    const question = asked?.request.kind === "question";
    return { kind: question ? "question" : "approve", tone: "needs-you", count: null };
  }
  if (!fresh && running) return { kind: "waiting", tone: "waiting", count: null };
  switch (agent.status.state) {
    case "failed":
    case "unresponsive":
      return { kind: "failed", tone: "failed", count: null };
    case "starting":
    case "working":
      return { kind: "working", tone: "working", count: null };
    case "blocked":
      if (limited(agent)) return { kind: "limited", tone: "muted", count: null };
      if (agent.status.on === "subagents" || runningChildren > 0)
        return { kind: "agents", tone: "waiting", count: runningChildren || null };
      return { kind: "waiting", tone: "waiting", count: null };
    case "idle":
      // Idle with work still under it waits on that work; settled, it finished.
      if (running)
        return runningChildren > 0
          ? { kind: "agents", tone: "waiting", count: runningChildren }
          : { kind: "waiting", tone: "waiting", count: null };
      return { kind: "done", tone: "finished", count: null };
    case "interrupted":
      return none;
  }
}

/** Why a node stopped or can't go on, in a few words; null when its status says it all. */
export function agentNodeReason(agent: Agent): string | null {
  const status = agent.status;
  if (status.state === "failed") {
    if (status.error.kind === "quota") return "ran out of usage";
    return firstLine(status.error.title ?? status.error.message, 80) ?? null;
  }
  if (status.state === "unresponsive") return "stopped responding";
  if (status.state === "interrupted") return "stopped";
  if (limited(agent))
    return status.state === "blocked" && status.until !== undefined
      ? `out of usage until ${formatClock(status.until)}`
      : "out of usage";
  return null;
}

const agentsWord = (count: number) => `${count} ${count === 1 ? "agent" : "agents"}`;
const needWords = (count: number) => (count === 1 ? "One needs you." : `${count} need you.`);

/**
 * The sentence over the tree, from the daemon's tree-aware sets. Subagents are counted; the
 * main agent is the one the thread is, so it never counts itself.
 */
export function agentTreeSummary(input: {
  agents: readonly Agent[];
  tasks: readonly BackgroundTask[];
  work: Work;
  /** Agents with a request of their own the person can answer. */
  asking: number;
  fresh: boolean;
}): AgentTreeSummary {
  const { agents, work, asking, fresh } = input;
  const subagents = agents.filter((agent) => agent.origin !== "root");
  const live = subagents.filter((agent) => work.running.has(agent.id));
  const commands = input.tasks.filter((task) => !task.internal && task.status === "running").length;
  if (!fresh) return { text: `${syncingWord} agents`, token: "neutral" };
  if (asking > 0) {
    const waiting = live.length - asking;
    return waiting > 0
      ? { text: `Waiting on ${agentsWord(live.length)}. ${needWords(asking)}`, token: "needsYou" }
      : {
          text: asking === 1 ? "One agent needs you." : `${asking} agents need you.`,
          token: "needsYou",
        };
  }
  const root = agents.find((agent) => agent.origin === "root");
  const rootWorks = root?.status.state === "working" || root?.status.state === "starting";
  if (live.length > 0)
    return rootWorks
      ? { text: `Working: ${agentsWord(live.length + 1)}`, token: "working" }
      : { text: `Waiting on ${agentsWord(live.length)}`, token: "waiting" };
  if (commands > 0)
    return {
      text: `Running ${commands} ${commands === 1 ? "command" : "commands"}`,
      token: "working",
    };
  if (work.running.size > 0) return { text: "Working", token: "working" };
  const failed = subagents.filter(
    (agent) => agent.status.state === "failed" || agent.status.state === "unresponsive",
  ).length;
  if (failed > 0)
    return failed === subagents.length
      ? { text: failed === 1 ? "The agent failed" : `${failed} agents failed`, token: "failed" }
      : { text: `${failed} failed. The rest finished.`, token: "failed" };
  return { text: subagents.length > 1 ? "All agents finished" : "Finished", token: "done" };
}
