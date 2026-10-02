import { expect, test } from "vitest";
import { Agent, AgentId, EventId, Thread } from "@ace/protocol";
import { applyDelivery, createThreadView } from "@ace/projection";
import { ThreadStore, defaultLimits } from "./index.ts";
const thread = Thread.parse({
  id: "parent-test",
  workspaceId: "workspace",
  title: "parents",
  provider: "codex",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const agent = Agent.parse({
  id: "child",
  threadId: thread.id,
  parentId: null,
  origin: "provider_subagent",
  native: { provider: "codex" },
  fidelity: "full",
  cwd: "/",
  status: { state: "working", activity: "thinking" },
  createdAt: 0,
});

test("reparenting preserves current children while removing empty historical parents", () => {
  const view = createThreadView(thread);
  applyDelivery(view, {
    type: "events",
    subscriptionId: "parents",
    afterSeq: 0,
    throughSeq: 1,
    events: [
      {
        seq: 1,
        id: EventId.parse("created"),
        at: 0,
        threadId: thread.id,
        payload: { type: "agent.created", agent },
      },
    ],
  });
  for (let seq = 2; seq <= 101; seq++)
    applyDelivery(view, {
      type: "events",
      subscriptionId: "parents",
      afterSeq: seq - 1,
      throughSeq: seq,
      events: [
        {
          seq,
          id: EventId.parse(`event-${seq}`),
          at: 0,
          threadId: thread.id,
          payload: {
            type: "agent.updated",
            agentId: agent.id,
            parentId: AgentId.parse(`parent-${seq}`),
          },
        },
      ],
    });
  expect(Object.keys(view.agentChildren)).toEqual(["parent-101"]);
  expect(view.agentChildren["parent-101"]).toEqual([agent.id]);
  expect(view.agents[agent.id]?.status.state).toBe("working");
});

test("a snapshot cannot retain more parent references than the entity budget", () => {
  const view = createThreadView(thread);
  view.agents[agent.id] = agent;
  view.agentChildren = { first: [agent.id], second: [agent.id] };
  const store = new ThreadStore({ ...defaultLimits, entities: 1 });
  expect(() => store.snapshot(view)).toThrow("capacity");
});
