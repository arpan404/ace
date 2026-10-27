import type { ThreadReader } from "@ace/client";
import type { Agent, Item } from "@ace/protocol";
import { agentName } from "./agents.ts";
import { modelLabel, providerNames } from "./providers.ts";
import type { StatusDisplay, StatusToken } from "./mobile-status.ts";
import { readSubagentBranch } from "./subagent-group.ts";
import {
  subagentEnded,
  subagentOutcome,
  subagentPhase,
  type SubagentPhase,
} from "./subagent-outcome.ts";
import { retryRequest } from "./subagent-retry.ts";

/*
 * A provider's own subagent as the native apps inspect it (the web's subagent view): what its
 * parent asked it, where its whole branch stands, the requests under it that wait on the person,
 * and what can be done about it: Stop while it runs, Ask parent to retry once it failed or was
 * stopped. Pure over one thread's reader. The branch rule is the one its card in the parent
 * reads, so it never reads done while anything under it works or waits on the person.
 */

export type SubagentReader = ThreadReader;

export interface SubagentInspection {
  agentId: string;
  name: string;
  provider: string;
  /** The model's label, else the provider's name. */
  model: string;
  /** Its parent: the thread's main agent (`agentId` null) or the subagent that started it. */
  parent: { agentId: string | null; name: string };
  /** What its parent asked it, from the call that started it. */
  prompt: { text: string; at: number } | null;
  phase: SubagentPhase;
  status: StatusDisplay;
  startedAt: number;
  /** When its branch ended; null while anything in it runs or waits. */
  endedAt: number | null;
  /** Requests from it or anything under it that wait on the person, oldest first. */
  requests: string[];
  /** Agents under it at any depth: Stop stops them too. */
  descendants: number;
  /** A person may stop it: its branch still runs and its provider lets one subagent be stopped. */
  stoppable: boolean;
  /** Ask its parent to run it again: only for its own failure or stop, on a thread that takes messages. */
  retry: { label: string } | null;
  /** The thread's main agent is busy, so a retry message waits for its turn to end. */
  parentBusy: boolean;
}

const phaseTokens: Record<SubagentPhase, StatusToken> = {
  running: "working",
  human: "needsYou",
  stalled: "unresponsive",
  done: "done",
  failed: "failed",
  stopped: "neutral",
};

const busy = new Set(["working", "waiting", "needs_you", "limited", "unresponsive"]);

function spawnOf(reader: SubagentReader, agent: Agent): Item | undefined {
  return agent.spawnedBy ? reader.item(agent.spawnedBy) : undefined;
}

/** What the parent asked: the spawn call's prompt, else its description, else its title. */
function promptOf(spawn: Item | undefined): { text: string; at: number } | null {
  if (spawn?.type !== "tool_call") return null;
  const detail = spawn.call.detail.kind === "agent.spawn" ? spawn.call.detail : undefined;
  const text = (detail?.prompt ?? detail?.description ?? spawn.call.title)?.trim();
  return text ? { text, at: spawn.createdAt } : null;
}

function descendantsOf(reader: SubagentReader, agentId: string): number {
  const children = new Map<string, string[]>();
  for (const id of reader.agentIds()) {
    const parent = reader.agent(id)?.parentId;
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  let count = 0;
  const seen = new Set([agentId]);
  const stack = [...(children.get(agentId) ?? [])];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    count++;
    stack.push(...(children.get(next) ?? []));
  }
  return count;
}

/** Pending requests whose asking agent is this one or under it. */
function branchRequests(reader: SubagentReader, agentId: string): string[] {
  return reader.interactionIds().filter((id) => {
    const interaction = reader.interaction(id);
    if (interaction?.state !== "pending") return false;
    let owner: string | null = interaction.agentId ?? null;
    const seen = new Set<string>();
    while (owner && !seen.has(owner)) {
      if (owner === agentId) return true;
      seen.add(owner);
      owner = reader.agent(owner)?.parentId ?? null;
    }
    return false;
  });
}

/** One subagent, inspected; undefined when it isn't in the loaded thread or is the main agent. */
export function subagentInspection(
  reader: SubagentReader,
  agentId: string,
  now: number,
): SubagentInspection | undefined {
  const agent = reader.agent(agentId);
  if (!agent || agent.origin === "root") return undefined;
  const branch = readSubagentBranch(reader, agentId).value;
  const phase = subagentPhase(branch?.state ?? "working");
  const ended = subagentEnded(phase);
  const parent = agent.parentId ? reader.agent(agent.parentId) : undefined;
  const direct = !parent || parent.origin === "root";
  const thread = reader.thread;
  const readOnlyChildren = thread?.capabilities?.childControls === "read-only";
  const ownEnd = agent.status.state === "failed" || agent.status.state === "interrupted";
  const endedAt = ended ? (branch?.end ?? agent.endedAt ?? null) : null;
  return {
    agentId,
    name: agentName(agent, spawnOf(reader, agent)),
    provider: agent.native.provider,
    model: agent.model ? modelLabel(agent.model) : providerNames[agent.native.provider],
    parent: direct
      ? { agentId: null, name: thread?.title ?? "Main agent" }
      : { agentId: parent.id, name: agentName(parent, spawnOf(reader, parent)) },
    prompt: promptOf(spawnOf(reader, agent)),
    phase,
    status: {
      label: subagentOutcome(phase, agent.createdAt, endedAt ?? undefined, now),
      token: phaseTokens[phase],
    },
    startedAt: agent.createdAt,
    endedAt,
    requests: branchRequests(reader, agentId),
    descendants: descendantsOf(reader, agentId),
    stoppable: !ended && !readOnlyChildren,
    retry:
      ended && ownEnd && !thread?.continuation
        ? { label: direct ? "Ask parent to retry" : "Ask main agent to retry" }
        : null,
    parentBusy: thread ? busy.has(thread.status.state) : false,
  };
}

/**
 * The message a retry sends the thread's main agent, or undefined when this subagent can't be
 * retried now (it is still going, ended well, or the thread takes no messages). It is only ever
 * sent on the person's press.
 */
export function subagentRetryMessage(
  reader: SubagentReader,
  agentId: string,
  now: number,
): string | undefined {
  const inspection = subagentInspection(reader, agentId, now);
  const agent = reader.agent(agentId);
  if (!inspection?.retry || !agent) return undefined;
  const spawn = spawnOf(reader, agent);
  const status = agent.status;
  return retryRequest({
    name: inspection.name,
    task: spawn?.type === "tool_call" ? spawn.call.title : undefined,
    ended:
      status.state === "interrupted"
        ? { kind: "stopped" }
        : { kind: "failed", reason: status.state === "failed" ? status.error.message : undefined },
  });
}
