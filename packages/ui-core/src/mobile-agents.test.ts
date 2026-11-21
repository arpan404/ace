import { Agent, Thread, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { livePill } from "./live-pill.ts";
import { agentSheet } from "./mobile-agents.ts";
import { readTurnActivity } from "./turn-activity.ts";

const agent = (id: string, status: AgentStatus, parentId: string | null = null) =>
  Agent.parse({
    id,
    parentId,
    threadId: "t1",
    origin: parentId ? "provider_subagent" : "root",
    native: { provider: "claude", nativeId: id },
    fidelity: "full",
    cwd: "/project",
    status,
    createdAt: 0,
  });

/** One thread's reader, as both the Agents sheet and the thread's chip read it. */
function reader(agents: Agent[], runningSubagentCount: number) {
  const byId = new Map(agents.map((entry) => [entry.id as string, entry]));
  const thread = Thread.parse({
    id: "t1",
    workspaceId: "project",
    title: "Work",
    provider: "claude",
    rootAgentId: "root",
    status: { state: "working", agents: 1 },
    createdAt: 0,
    updatedAt: 0,
    live: { runningSubagentCount },
  });
  return {
    thread,
    context: undefined,
    unconfirmed: false,
    syncing: false,
    order: [],
    item: () => undefined,
    run: () => undefined,
    runIds: () => [],
    agentIds: () => [...byId.keys()],
    agent: (id: string) => byId.get(id),
    taskIds: () => [],
    task: () => undefined,
    interactionIds: () => [],
    interaction: () => undefined,
    usage: () => undefined,
    queue: undefined,
  };
}

test("the Agents header counts the subagents the thread's chip counts, before every row arrived", () => {
  const working: AgentStatus = { state: "working", activity: "tool" };
  // The daemon knows two subagents work; only one row has arrived on this phone.
  const read = reader([agent("root", working), agent("helper", working, "root")], 2);
  const chip = livePill({
    activity: readTurnActivity(read, "root").activity,
    queued: 0,
    goal: undefined,
    requestShown: false,
  });
  expect(chip?.segments.find((segment) => segment.kind === "subagents")?.label).toBe("2 subagents");
  expect(agentSheet(read).summary.text).toBe("Working with 2 subagents");
});
