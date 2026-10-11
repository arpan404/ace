import type { AgentId, AgentStatus, Event, EventPayload } from "@ace/protocol";

interface Evidence {
  id?: AgentId;
  placeholder: boolean;
  unsafe: boolean;
  usageAt?: number;
  status?: AgentStatus;
  silent: boolean;
}

/** Legacy canonical events cannot recover every native fact. Only a usage-only
 * placeholder with a later silence transition is affirmative diagnostic evidence.
 * Work, links, descendants, retries, and ambiguous disconnect timing veto repair.
 */
export class CanonicalCompletionEvidence {
  private readonly agents = new Map<string, Evidence>();
  private get(id: string): Evidence {
    let evidence = this.agents.get(id);
    if (!evidence) {
      evidence = { placeholder: false, unsafe: false, silent: false };
      this.agents.set(id, evidence);
    }
    return evidence;
  }
  private block(id: string): void {
    this.get(id).unsafe = true;
  }
  record(event: Event): void {
    const p = event.payload;
    if (p.type === "agent.created") {
      const agent = p.agent;
      const evidence = this.get(agent.id);
      if (evidence.id) evidence.unsafe = true;
      evidence.id = agent.id;
      evidence.placeholder =
        agent.origin === "provider_subagent" &&
        agent.fidelity === "placeholder" &&
        agent.parentId !== null &&
        agent.childThreadId === undefined &&
        agent.status.state === "starting";
      evidence.status = agent.status;
      if (agent.parentId) this.block(agent.parentId);
    } else if (p.type === "agent.status") {
      const evidence = this.get(p.agentId);
      evidence.status = p.status;
      evidence.silent =
        p.status.state === "unresponsive" &&
        p.status.lastSignalAt === evidence.usageAt &&
        event.at > p.status.lastSignalAt;
      if (!evidence.silent && p.status.state !== "starting") evidence.unsafe = true;
    } else if (p.type === "usage.updated") {
      this.get(p.agentId).usageAt = event.at;
    } else {
      if ("agentId" in p && typeof p.agentId === "string") this.block(p.agentId);
      if (p.type === "agent.updated" && p.parentId) this.block(p.parentId);
      if (p.type === "run.started") this.block(p.run.agentId);
      if ((p.type === "item.created" || p.type === "item.updated") && p.item.agentId)
        this.block(p.item.agentId);
      if (p.type === "interaction.opened") this.block(p.interaction.agentId);
      if (p.type === "background_task.started") this.block(p.task.agentId);
    }
  }
  corrections(): EventPayload[] {
    return [...this.agents.values()].flatMap((evidence) =>
      evidence.id &&
      evidence.placeholder &&
      !evidence.unsafe &&
      evidence.silent &&
      evidence.status?.state === "unresponsive" &&
      evidence.status.lastSignalAt === evidence.usageAt
        ? [
            {
              type: "agent.status" as const,
              agentId: evidence.id,
              status: evidence.status,
              completionRelevant: false,
            },
          ]
        : [],
    );
  }
}
