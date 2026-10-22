import type {
  Agent,
  AgentStatus,
  BackgroundTask,
  Interaction,
  Item,
  ThreadStatus,
} from "@ace/protocol";
import { isActionableInteraction } from "@ace/core/human";
import { agentStatusLabel, type Tone } from "./status.ts";
import { providerNames } from "./providers.ts";
import { firstLine } from "./line-text.ts";

/** What names an agent: the root by its provider, any other agent by its own words. */
export interface AgentNaming {
  origin?: Agent["origin"] | undefined;
  native?: Pick<Agent["native"], "provider"> | undefined;
  name?: string | undefined;
  role?: string | undefined;
}

/**
 * What the call that started a subagent says it is for: the task's description, else the kind of
 * agent asked for, else the first words of its prompt; a delegation's title or role.
 */
function spawnName(spawn: Item | undefined): string | undefined {
  if (spawn?.type === "delegation.started") return firstLine(spawn.title) ?? firstLine(spawn.role);
  if (spawn?.type !== "tool_call" || spawn.call.detail.kind !== "agent.spawn") return undefined;
  const detail = spawn.call.detail;
  return (
    firstLine(detail.description) ?? firstLine(detail.agentType) ?? firstLine(detail.prompt, 60)
  );
}

/**
 * The one name an agent goes by everywhere (trees, subagent rows and headers, messages, logs,
 * "<name> is asking"): the root is its provider; a subagent is its own name, else its role,
 * else what `spawn` (the call that started it, when loaded) says it is for, and "Subagent" only
 * when nothing says. Blank names count as none.
 */
export function agentName(agent: AgentNaming | undefined, spawn?: Item | undefined): string {
  if (agent?.origin === "root" && agent.native) return providerNames[agent.native.provider];
  return (
    firstLine(agent?.name, 256) ?? firstLine(agent?.role, 256) ?? spawnName(spawn) ?? "Subagent"
  );
}

/** What an agent is doing, in the quiet lower-case phrasing of the tree ("waiting for subagents"). */
export function describeActivity(status: AgentStatus, toolTitle?: string): string {
  switch (status.state) {
    case "starting":
      return "starting";
    case "working":
      if (status.detail) return status.detail;
      if (status.activity === "tool") return toolTitle ?? "running a tool";
      return {
        thinking: "thinking",
        responding: "writing",
        compacting: "compacting its context",
        retrying: "retrying",
        starting_turn: "starting a turn",
      }[status.activity];
    case "blocked":
      return {
        human: "needs you",
        subagents: "waiting for subagents",
        background_task: "waiting on a background task",
        rate_limit: "rate limited",
        network: "waiting for the network",
        upstream: "provider is retrying",
      }[status.on];
    case "idle":
      return "done";
    case "interrupted":
      return "stopped";
    case "failed":
      return status.error.message;
    case "unresponsive":
      return "not responding";
  }
}

export type AgentGlyph = "spinner" | "waiting" | "needs-you" | "failed" | "done" | "stopped";
export function glyphOf(status: AgentStatus): AgentGlyph {
  switch (status.state) {
    case "starting":
    case "working":
      return "spinner";
    case "blocked":
      return status.on === "human" ? "needs-you" : "waiting";
    case "failed":
    case "unresponsive":
      return "failed";
    case "idle":
      return "done";
    case "interrupted":
      return "stopped";
  }
}

export const isRunning = (agent: Pick<Agent, "status">) =>
  agent.status.state === "working" ||
  agent.status.state === "starting" ||
  agent.status.state === "blocked";

/** Unsettled work belongs to every ancestor, even after its own turn has ended. */
export function agentTreeWork(
  agents: readonly Agent[],
  tasks: readonly BackgroundTask[],
  interactions: readonly Interaction[],
  threadStatus?: ThreadStatus,
): { running: ReadonlySet<string>; needsYou: ReadonlySet<string> } {
  const byId = new Map<string, Agent>(agents.map((agent) => [agent.id, agent]));
  const running = new Set<string>();
  const needsYou = new Set<string>();
  const includeAncestors = (id: string, target: Set<string>) => {
    let current: string | null | undefined = id;
    while (current && !target.has(current)) {
      target.add(current);
      current = byId.get(current)?.parentId;
    }
  };
  for (const agent of agents) {
    if (isRunning(agent)) includeAncestors(agent.id, running);
    if (agent.status.state === "blocked" && agent.status.on === "human")
      includeAncestors(agent.id, needsYou);
  }
  for (const task of tasks)
    if (task.status === "running" || task.status === "unknown")
      includeAncestors(task.agentId, running);
  for (const interaction of interactions) {
    if (interaction.state !== "pending") continue;
    // Pending work stays unsettled even when its working owner can continue without an answer.
    includeAncestors(interaction.agentId, running);
    if (isActionableInteraction(interaction, byId.get(interaction.agentId)?.status))
      includeAncestors(interaction.agentId, needsYou);
  }
  // Metadata can arrive before the entity facts that explain the root's pending work.
  const root = agents.find((agent) => agent.origin === "root");
  if (root && threadStatus && !["done", "new", "failed"].includes(threadStatus.state)) {
    running.add(root.id);
    if (threadStatus.state === "needs_you") needsYou.add(root.id);
  }
  return { running, needsYou };
}

/** Effective tree state and copy share the same descendant and metadata policy. */
export function agentWorkState(
  agent: Agent,
  work: ReturnType<typeof agentTreeWork>,
  evidence: { fresh: boolean; toolTitle?: string | undefined },
): { running: boolean; needsYou: boolean; label: string; tone: Tone; activity: string } {
  const running = work.running.has(agent.id);
  const needsYou = work.needsYou.has(agent.id);
  const waiting = running && !isRunning(agent);
  const label =
    !evidence.fresh && running
      ? "Last seen"
      : needsYou
        ? "Needs you"
        : waiting
          ? "Waiting on work"
          : agentStatusLabel(agent.status).label;
  const activity =
    agent.status.state === "failed"
      ? "Couldn't finish. Open the agent for details."
      : (!evidence.fresh && running) || needsYou || waiting
        ? label
        : describeActivity(agent.status, evidence.toolTitle);
  const tone = needsYou
    ? "needs-you"
    : waiting || (!evidence.fresh && running)
      ? "waiting"
      : agentStatusLabel(agent.status).tone;
  return { running, needsYou, label, tone, activity };
}

const taskStates: Record<BackgroundTask["status"], string> = {
  running: "running",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  unknown: "possibly running",
};
export const taskState = (task: BackgroundTask) => taskStates[task.status];

const taskLines: Record<BackgroundTask["status"], string> = {
  completed: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Stopped",
  running: "Running in background",
};
/** A background command's line in the transcript, before its command: "Running in background". */
export const backgroundTaskLine = (status: BackgroundTask["status"]) => taskLines[status];

/** A background shell's command comes from its tool call; the task title is a fallback. */
export function backgroundCommand(
  task: Pick<BackgroundTask, "title">,
  item: Item | undefined,
): string {
  return item?.type === "tool_call" && item.call.detail.kind === "shell"
    ? item.call.detail.command
    : task.title;
}
