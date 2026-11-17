import type { ThreadReader } from "@ace/client";
import {
  Agent,
  Interaction,
  Item,
  Thread,
  type AgentStatus,
  type ThreadStatus,
} from "@ace/protocol";

/** A thread store as the client keeps one, built from parsed entities, for view tests. */
export function threadReader(input: {
  status?: ThreadStatus;
  agents?: { id: string; status: AgentStatus; parent?: string }[];
  items?: unknown[];
  interactions?: unknown[];
}): ThreadReader {
  const agents = new Map(
    (input.agents ?? [{ id: "root", status: { state: "idle" } }]).map((agent) => [
      agent.id,
      Agent.parse({
        id: agent.id,
        threadId: "t1",
        parentId: agent.parent ?? (agent.id === "root" ? null : "root"),
        origin: agent.id === "root" ? "root" : "provider_subagent",
        native: { provider: "claude", nativeId: agent.id },
        fidelity: "full",
        cwd: "/repo",
        status: agent.status,
        createdAt: 1000,
        ...(agent.id === "root" ? {} : { name: agent.id }),
      }),
    ]),
  );
  const items = new Map(
    (input.items ?? []).map((raw) => {
      const item = Item.parse(raw);
      return [item.id as string, item];
    }),
  );
  const interactions = new Map(
    (input.interactions ?? []).map((raw) => {
      const interaction = Interaction.parse(raw);
      return [interaction.id as string, interaction];
    }),
  );
  const thread = Thread.parse({
    id: "t1",
    workspaceId: "ace",
    title: "Fix relay reconnect after sleep",
    provider: "claude",
    rootAgentId: "root",
    status: input.status ?? { state: "done" },
    createdAt: 0,
    updatedAt: 0,
  });
  return {
    error: undefined,
    thread,
    queue: undefined,
    context: undefined,
    order: [...items.keys()],
    cursor: 1,
    itemsBefore: null,
    agentIds: () => [...agents.keys()],
    runIds: () => [],
    children: (id) =>
      [...agents.values()].filter((agent) => agent.parentId === id).map((agent) => agent.id),
    interactionIds: () => [...interactions.keys()],
    taskIds: () => [],
    item: (id) => items.get(id),
    agent: (id) => agents.get(id),
    run: () => undefined,
    interaction: (id) => interactions.get(id),
    task: () => undefined,
    usage: () => undefined,
    contextMeter: () => undefined,
    usageSnapshot: () => undefined,
    truncated: () => false,
  };
}
