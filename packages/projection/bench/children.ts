import { Agent, Event, Thread } from "@ace/protocol";
import { applyEvent, createThreadView, rebuildAgentChildren } from "../src/index.ts";

// Public-API timings only; correctness tests have no wall-clock threshold.
const thread = Thread.parse({
  id: "bench",
  workspaceId: "workspace",
  title: "Sibling tree benchmark",
  provider: "codex",
  status: { state: "new" },
  createdAt: 0,
  updatedAt: 0,
});
for (const count of [2_000, 20_000]) {
  const view = createThreadView(thread);
  view.agents = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const agent = Agent.parse({
        id: `child-${index}`,
        threadId: thread.id,
        parentId: "parent",
        origin: "provider_subagent",
        cwd: "/repo",
        fidelity: "placeholder",
        native: { provider: "codex" },
        status: { state: "starting" },
        createdAt: 0,
      });
      return [agent.id, agent];
    }),
  );
  const samples = Array.from({ length: 5 }, () => {
    const start = performance.now();
    rebuildAgentChildren(view);
    return performance.now() - start;
  }).toSorted((a, b) => a - b);
  console.log(
    JSON.stringify({
      siblings: count,
      ms: +(samples[2] ?? 0).toFixed(2),
      children: view.agentChildren.parent?.length,
    }),
  );
}

// Also measure live sibling creation, which must not scan accumulated siblings.
for (const count of [2_000, 20_000]) {
  const view = createThreadView(thread);
  const agent = Agent.parse({
    id: "child",
    threadId: thread.id,
    parentId: "parent",
    origin: "provider_subagent",
    cwd: "/repo",
    fidelity: "full",
    native: { provider: "codex" },
    status: { state: "starting" },
    createdAt: 0,
  });
  const events = Array.from({ length: count }, (_, index) =>
    Event.parse({
      seq: index + 1,
      id: `e-${index}`,
      threadId: thread.id,
      at: 0,
      payload: { type: "agent.created", agent: { ...agent, id: `child-${index}` } },
    }),
  );
  const started = performance.now();
  for (const event of events) applyEvent(view, event);
  console.log(
    JSON.stringify({
      createdSiblings: count,
      ms: +(performance.now() - started).toFixed(2),
      children: view.agentChildren.parent?.length,
    }),
  );
}
