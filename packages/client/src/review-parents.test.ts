import { expect, test } from "vitest";
import { Agent, Event, Thread } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
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

test("a snapshot discards stale parent references without rejecting active agents over its recent budget", () => {
  const view = createThreadView(thread);
  view.agents[agent.id] = agent;
  const second = Agent.parse({ ...agent, id: "second-child", parentId: agent.id });
  view.agents[second.id] = second;
  view.agentChildren = { first: [agent.id], second: [agent.id] };
  const store = new ThreadStore({ ...defaultLimits, entities: 1 });
  store.snapshot(view);
  expect(store.agent(agent.id)?.status.state).toBe("working");
  expect(store.agent(second.id)?.status.state).toBe("working");
  expect(store.children(agent.id)).toEqual([second.id]);
  expect(store.export().view?.agentChildren).toEqual({ [agent.id]: [second.id] });
});

test("a late spawn link announces ancestry and replaces the individual agent identity", () => {
  const view = createThreadView(thread);
  view.agents[agent.id] = agent;
  const store = new ThreadStore(defaultLimits);
  store.snapshot(view);
  const before = store.agent(agent.id);
  const links = store.select(["agents"], (reader) => reader.agent(agent.id)?.spawnedBy);
  const seen: (string | null | undefined)[] = [];
  const stop = links.subscribe(() => seen.push(links.getSnapshot()));
  const keys = new Set<string>();
  const unobserve = store.observe((changed) => {
    if (changed !== "all") for (const key of changed) keys.add(key);
  });
  store.delivery({
    type: "events",
    subscriptionId: "parents",
    afterSeq: 0,
    throughSeq: 1,
    events: [
      Event.parse({
        id: "linked",
        threadId: thread.id,
        seq: 1,
        at: 1,
        payload: { type: "agent.updated", agentId: agent.id, spawnedBy: "spawn" },
      }),
    ],
  });
  stop();
  unobserve();
  expect(keys).toContain(`agent:${agent.id}`);
  expect(keys).toContain("agents");
  expect(store.agent(agent.id)).not.toBe(before);
  expect(before?.spawnedBy).toBeUndefined();
  expect(seen).toEqual(["spawn"]);
});
