import { Agent, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { agentTreeWork, needsYou, subagentBranchStates } from "./index.ts";

const restarted: AgentStatus = {
  state: "failed",
  error: { kind: "process_exit", message: "Daemon restarted; previous provider work stopped" },
};

const agent = (id: string, nativeId: string, status: AgentStatus, createdAt: number) =>
  Agent.parse({
    id,
    parentId: id === "root" ? null : "root",
    threadId: "thread",
    origin: id === "root" ? "root" : "provider_subagent",
    native: { provider: "claude", nativeId },
    fidelity: "full",
    cwd: "/project",
    status,
    createdAt,
  });

const root = agent("root", "session", { state: "idle" }, 0);

test("a run a restart stopped needs no one once the same agent ran again", () => {
  const agents = [
    root,
    agent("first", "task-1", restarted, 1),
    agent("again", "task-1", { state: "idle" }, 2),
  ];
  expect(needsYou(agents, [])).toEqual([]);
  expect(subagentBranchStates(agents, agentTreeWork(agents, [], []))).toEqual(["done"]);
});

test("a failure stays when it is the agent's latest run", () => {
  const agents = [
    root,
    agent("first", "task-1", { state: "idle" }, 1),
    agent("again", "task-1", restarted, 2),
  ];
  expect(needsYou(agents, [])).toMatchObject([{ kind: "failed", agentId: "again" }]);
});

test("runs of the same agent that both still work both count as working", () => {
  const working: AgentStatus = { state: "working", activity: "thinking" };
  const agents = [root, agent("first", "task-1", working, 1), agent("again", "task-1", working, 2)];
  expect(subagentBranchStates(agents, agentTreeWork(agents, [], []))).toEqual([
    "working",
    "working",
  ]);
});

test("different agents never fold into one", () => {
  const agents = [root, agent("one", "task-1", restarted, 1), agent("two", "task-2", restarted, 2)];
  expect(needsYou(agents, [])).toHaveLength(2);
});

test("a delegated child queued for its parent's run slot counts as queued, not working", () => {
  const working: AgentStatus = { state: "working", activity: "thinking" };
  const queued: AgentStatus = { state: "blocked", on: "queue", refs: ["child-thread"] };
  const agents = [
    root,
    agent("running", "task-1", working, 1),
    agent("waiting", "task-2", queued, 2),
  ];
  expect(subagentBranchStates(agents, agentTreeWork(agents, [], []))).toEqual([
    "working",
    "queued",
  ]);
});
