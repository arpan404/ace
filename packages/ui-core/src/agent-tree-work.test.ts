import { Agent, BackgroundTask, Interaction, type AgentStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { agentTreeWork, agentWorkState } from "./index.ts";

const agent = (id: string, parentId: string | null, status: AgentStatus) =>
  Agent.parse({
    id,
    parentId,
    threadId: "thread",
    origin: parentId ? "ace" : "root",
    native: { provider: "codex", nativeId: id },
    fidelity: "full",
    cwd: "/project",
    status,
    createdAt: 0,
  });

test("an ended parent remains running while a nested child waits for a human", () => {
  const agents = [
    agent("root", null, { state: "idle" }),
    agent("parent", "root", { state: "interrupted" }),
    agent("child", "parent", { state: "blocked", on: "human", refs: [] }),
  ];
  const work = agentTreeWork(agents, [], []);
  expect([...work.running].toSorted()).toEqual(["child", "parent", "root"]);
  expect([...work.needsYou].toSorted()).toEqual(["child", "parent", "root"]);
  expect(
    agentTreeWork(
      agents.map((entry) => agent(entry.id, entry.parentId, { state: "idle" })),
      [],
      [],
    ).running.size,
  ).toBe(0);
});

test("an agent stays active after its turn ends until its background work settles", () => {
  const agents = [
    agent("root", null, { state: "idle" }),
    agent("child", "root", { state: "idle" }),
  ];
  const task = BackgroundTask.parse({
    id: "shell",
    agentId: "child",
    kind: "shell",
    title: "Build",
    status: "running",
    stoppable: true,
    startedAt: 0,
  });
  expect([...agentTreeWork(agents, [task], []).running].toSorted()).toEqual(["child", "root"]);
  expect(agentTreeWork(agents, [{ ...task, status: "completed" }], []).running.size).toBe(0);
});

test("a pending question keeps the agent and its ancestors waiting even between status updates", () => {
  const agents = [
    agent("root", null, { state: "idle" }),
    agent("child", "root", { state: "idle" }),
  ];
  const question = Interaction.parse({
    id: "question",
    agentId: "child",
    threadId: "thread",
    blocking: false,
    state: "pending",
    request: { kind: "question", questions: [] },
    createdAt: 0,
  });
  const work = agentTreeWork(agents, [], [question]);
  expect([...work.running].toSorted()).toEqual(["child", "root"]);
  expect([...work.needsYou].toSorted()).toEqual(["child", "root"]);
  expect(agentTreeWork(agents, [], [{ ...question, state: "resolved" }]).running.size).toBe(0);
});

test("a working child with a non-blocking question stays active without requesting attention", () => {
  const agents = [
    agent("root", null, { state: "idle" }),
    agent("child", "root", { state: "working", activity: "responding" }),
  ];
  const question = Interaction.parse({
    id: "question",
    agentId: "child",
    threadId: "thread",
    blocking: false,
    state: "pending",
    request: { kind: "question", questions: [] },
    createdAt: 0,
  });
  const work = agentTreeWork(agents, [], [question]);
  expect([...work.running].toSorted()).toEqual(["child", "root"]);
  expect(work.needsYou.size).toBe(0);
  expect(
    [...agentTreeWork(agents, [], [{ ...question, blocking: true }]).needsYou].toSorted(),
  ).toEqual(["child", "root"]);
  const idle = agents.map((entry) => agent(entry.id, entry.parentId, { state: "idle" }));
  expect([...agentTreeWork(idle, [], [question]).needsYou].toSorted()).toEqual(["child", "root"]);
});

test("pending metadata keeps the main agent waiting until the explaining facts arrive", () => {
  const root = agent("root", null, { state: "idle" });
  expect(
    agentWorkState(root, agentTreeWork([root], [], [], { state: "working", agents: 1 }), {
      fresh: true,
    }),
  ).toMatchObject({ running: true, label: "Waiting on work" });
  expect(
    agentWorkState(root, agentTreeWork([root], [], [], { state: "needs_you", interactions: 1 }), {
      fresh: true,
    }),
  ).toMatchObject({ running: true, needsYou: true, label: "Needs you" });
  expect(
    agentWorkState(root, agentTreeWork([root], [], [], { state: "done" }), { fresh: true }),
  ).toMatchObject({ running: false, needsYou: false, label: "Idle" });
});

test("settled metadata cannot hide a child still working, and cached work stays last seen", () => {
  const root = agent("root", null, { state: "idle" });
  const child = agent("child", "root", { state: "working", activity: "responding" });
  const work = agentTreeWork([root, child], [], [], { state: "done" });
  expect(agentWorkState(root, work, { fresh: true })).toMatchObject({
    running: true,
    label: "Waiting on work",
  });
  expect(agentWorkState(root, work, { fresh: false })).toMatchObject({
    running: true,
    label: "Last seen",
    activity: "Last seen",
  });
});

test("a failed tree row hides provider diagnostics behind a useful detail action", () => {
  const failed = agent("child", "root", {
    state: "failed",
    error: { kind: "provider", message: "private diagnostic" },
  });
  const state = agentWorkState(failed, agentTreeWork([failed], [], []), { fresh: true });
  expect(state.label).toBe("Failed");
  expect(state.activity).toBe("Couldn't finish. Open the agent for details.");
});
