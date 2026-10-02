import { Agent, Event, Thread, type EventPayload } from "@ace/protocol";
import { expect, it } from "vitest";
import { applyEvent, createThreadView } from "./index.ts";

it("appends new siblings without rereading older siblings and preserves order across replay and moves", () => {
  const thread = Thread.parse({
    id: "t",
    workspaceId: "w",
    provider: "codex",
    title: "Siblings",
    status: { state: "new" },
    createdAt: 0,
    updatedAt: 0,
  });
  const view = createThreadView(thread);
  let seq = 0;
  const send = (payload: EventPayload) =>
    applyEvent(view, Event.parse({ id: `e${++seq}`, seq, threadId: thread.id, at: 0, payload }));
  const agent = (id: string, parentId = "parent") =>
    Agent.parse({
      id,
      threadId: thread.id,
      parentId,
      origin: "provider_subagent",
      fidelity: "full",
      cwd: "/repo",
      native: { provider: "codex" },
      status: { state: "starting" },
      createdAt: 0,
    });
  send({ type: "agent.created", agent: agent("first") });
  let reads = 0;
  view.agentChildren.parent = new Proxy(view.agentChildren.parent ?? [], {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  for (let i = 0; i < 1000; i++) send({ type: "agent.created", agent: agent(`child-${i}`) });
  expect(reads).toBe(0);
  expect(view.agentChildren.parent).toHaveLength(1001);
  send({ type: "agent.created", agent: agent("first") });
  send({ type: "agent.updated", agentId: agent("first").id, parentId: agent("x").parentId });
  expect(reads).toBe(0);
  expect(view.agentChildren.parent).toHaveLength(1001);
  send({ type: "agent.created", agent: agent("first", "other") });
  expect(view.agentChildren.other).toEqual(["first"]);
  expect(view.agentChildren.parent?.slice(0, 2)).toEqual(["child-0", "child-1"]);
  send({ type: "agent.updated", agentId: agent("first").id, parentId: agent("x").parentId });
  expect(view.agentChildren.parent?.at(-1)).toBe("first");
  expect(view.agentChildren.parent).toHaveLength(1001);
  expect(view.agentChildren.other).toEqual([]);
});
