import { Agent, Event, Thread, type EventBatch, type Progress } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { applyDelivery, applyEvent, createThreadView } from "./index.ts";
const thread = Thread.parse({
  id: "t",
  workspaceId: "w",
  title: "Before",
  provider: "codex",
  status: { state: "new" },
  createdAt: 1,
  updatedAt: 1,
});
function event(seq: number, title: string) {
  return Event.parse({
    id: `e${seq}`,
    seq,
    at: seq,
    threadId: thread.id,
    payload: { type: "thread.updated", title },
  });
}
function batch(afterSeq: number, throughSeq: number, events: Event[]): EventBatch {
  return { type: "events", subscriptionId: "s", afterSeq, throughSeq, events };
}
describe("scoped projection delivery", () => {
  it("accepts filtered host gaps and advances to the batch watermark", () => {
    const view = createThreadView(thread, 2);
    expect(applyDelivery(view, batch(2, 8, [event(5, "After")]))).toEqual({ kind: "applied" });
    expect(view.seq).toBe(8);
    expect(view.thread.title).toBe("After");
    const progress: Progress = {
      type: "progress",
      subscriptionId: "s",
      afterSeq: 8,
      throughSeq: 12,
    };
    expect(applyDelivery(view, progress).kind).toBe("applied");
    expect(view.seq).toBe(12);
    expect(view.thread.title).toBe("After");
    expect(applyDelivery(view, progress).kind).toBe("ignored");
  });
  it("rejects an out-of-scope batch atomically before any item or thread mutation", () => {
    const view = createThreadView(thread, 2);
    const outside = {
      ...event(6, "Outside"),
      threadId: Thread.parse({ ...thread, id: "other" }).id,
    };
    expect(applyDelivery(view, batch(2, 8, [event(5, "Partial"), outside])).kind).toBe("gap");
    expect(view.seq).toBe(2);
    expect(view.thread.title).toBe("Before");
    expect(applyEvent(view, { ...outside, seq: 3 }).kind).toBe("gap");
    expect(view.seq).toBe(2);
    expect(view.thread.title).toBe("Before");
  });
  it("refuses missing or partially overlapping intervals without changing the view", () => {
    const view = createThreadView(thread, 2);
    expect(applyDelivery(view, batch(4, 8, [event(5, "Lost predecessor")]))).toEqual({
      kind: "gap",
      expected: 2,
      received: 4,
    });
    expect(applyDelivery(view, batch(0, 8, [event(5, "Overlap")])).kind).toBe("gap");
    expect(view.seq).toBe(2);
    expect(view.thread.title).toBe("Before");
  });
  it("validates every range before applying any event", () => {
    const view = createThreadView(thread, 2);
    expect(
      applyDelivery(view, batch(2, 8, [event(5, "Partial"), event(4, "Out of order")])).kind,
    ).toBe("gap");
    expect(applyDelivery(view, batch(2, 8, [event(9, "Beyond watermark")])).kind).toBe("gap");
    expect(view.seq).toBe(2);
    expect(view.thread.title).toBe("Before");
  });
});
describe("late agent linkage", () => {
  it("moves a child between parents, promotes it to a root, and keeps completed native metadata", () => {
    const view = createThreadView(thread);
    const agent = Agent.parse({
      id: "child",
      threadId: thread.id,
      parentId: "old",
      origin: "provider_subagent",
      fidelity: "placeholder",
      native: { provider: "codex" },
      cwd: "/old",
      status: { state: "starting" },
      createdAt: 1,
    });
    applyEvent(
      view,
      Event.parse({
        seq: 1,
        id: "created",
        at: 1,
        threadId: thread.id,
        payload: { type: "agent.created", agent },
      }),
    );
    const payload = {
      type: "agent.updated",
      agentId: agent.id,
      parentId: "new",
      origin: "ace",
      fidelity: "full",
      native: { provider: "opencode", nativeId: "native-child" },
      cwd: "/new",
      role: "researcher",
    };
    const linked = Event.parse({ seq: 2, id: "linked", at: 2, threadId: thread.id, payload });
    applyEvent(view, linked);
    expect(view.agentChildren.old).toEqual([]);
    expect(view.agentChildren.new).toEqual([agent.id]);
    expect(view.agents.child).toMatchObject({
      parentId: "new",
      origin: "ace",
      fidelity: "full",
      native: { provider: "opencode", nativeId: "native-child" },
      cwd: "/new",
      role: "researcher",
    });
    applyEvent(view, { ...linked, seq: 3 });
    expect(view.agentChildren.new).toEqual([agent.id]);
    applyEvent(
      view,
      Event.parse({
        seq: 4,
        id: "root",
        at: 4,
        threadId: thread.id,
        payload: { type: "agent.updated", agentId: agent.id, parentId: null },
      }),
    );
    expect(view.agentChildren.new).toEqual([]);
    expect(view.agents.child?.parentId).toBeNull();
  });
});
