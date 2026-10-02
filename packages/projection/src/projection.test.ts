import {
  Agent,
  BackgroundTask,
  Event,
  Interaction,
  Item,
  Run,
  Thread,
  ThreadView,
  type EventPayload,
} from "@ace/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyThreadListEvent,
  createThreadListView,
  createThreadView,
} from "./index.ts";

const thread = Thread.parse({
  id: "t",
  workspaceId: "w",
  title: "Title",
  provider: "codex",
  status: { state: "new" },
  createdAt: 1,
  updatedAt: 1,
});
const agent = Agent.parse({
  id: "a",
  threadId: "t",
  parentId: "parent",
  origin: "provider_subagent",
  native: { provider: "codex" },
  fidelity: "full",
  cwd: "/repo",
  status: { state: "starting" },
  createdAt: 1,
});
const message = Item.parse({
  id: "message",
  agentId: "a",
  type: "message",
  role: "assistant",
  complete: false,
  createdAt: 1,
  parts: [{ type: "text", text: "hello" }],
});
function event(seq: number, payload: EventPayload): Event {
  return Event.parse({ seq, id: `e${seq}`, threadId: "t", at: seq, payload });
}
function fold(payloads: EventPayload[]) {
  const view = createThreadView(thread);
  const list = createThreadListView();
  payloads.forEach((p, i) => {
    expect(applyEvent(view, event(i + 1, p))).toEqual({ kind: "applied" });
    applyThreadListEvent(list, event(i + 1, p));
  });
  return { view, list };
}
describe("projection", () => {
  it("folds every payload type and preserves JSON data and tree links", () => {
    const run = Run.parse({
      id: "r",
      threadId: "t",
      agentId: "a",
      trigger: "unknown",
      state: "active",
      startedAt: 1,
    });
    const interaction = Interaction.parse({
      id: "q",
      threadId: "t",
      agentId: "a",
      blocking: true,
      request: { kind: "approval", title: "Allow?", options: [] },
      state: "pending",
      createdAt: 1,
    });
    const task = BackgroundTask.parse({
      id: "b",
      agentId: "a",
      kind: "shell",
      title: "Build",
      status: "running",
      stoppable: true,
      startedAt: 1,
    });
    const { view, list } = fold([
      { type: "thread.created", thread },
      {
        type: "thread.updated",
        title: "Changed",
        status: { state: "working", agents: 1 },
        archivedAt: 2,
      },
      { type: "agent.created", agent },
      { type: "agent.status", agentId: agent.id, status: { state: "idle" } },
      {
        type: "agent.updated",
        agentId: agent.id,
        name: "Child",
        model: "model",
        background: true,
        endedAt: 5,
      },
      { type: "run.started", run },
      { type: "run.ended", runId: run.id, state: "completed", trigger: "spawn", endedAt: 7 },
      { type: "item.created", item: message },
      {
        type: "item.delta",
        itemId: message.id,
        agentId: agent.id,
        field: "text",
        append: " world",
      },
      { type: "item.updated", item: { ...message, complete: true } },
      { type: "interaction.opened", interaction },
      {
        type: "interaction.closed",
        interactionId: interaction.id,
        state: "resolved",
        resolution: { kind: "approval", optionId: "yes" },
        closedAt: 12,
      },
      { type: "background_task.started", task },
      { type: "background_task.updated", taskId: task.id, status: "completed", endedAt: 14 },
      {
        type: "usage.updated",
        agentId: agent.id,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.02,
      },
    ]);
    expect(view.thread).toMatchObject({ title: "Changed", archivedAt: 2, updatedAt: 15 });
    expect(view.agents.a).toMatchObject({
      name: "Child",
      model: "model",
      background: true,
      status: { state: "idle" },
    });
    expect(view.agentChildren.parent).toEqual(["a"]);
    expect(view.runs.r).toMatchObject({ state: "completed", trigger: "spawn", endedAt: 7 });
    expect(view.itemOrder).toEqual(["message"]);
    expect(view.items.message).toMatchObject({
      complete: true,
      parts: [{ type: "text", text: "hello" }],
    });
    expect(view.interactions.q).toMatchObject({ state: "resolved", closedAt: 12 });
    expect(view.backgroundTasks.b).toMatchObject({ status: "completed", endedAt: 14 });
    expect(view.usage.a).toMatchObject({ inputTokens: 100, outputTokens: 50, costUsd: 0.02 });
    expect(list.threads.t).toEqual(view.thread);
    expect(ThreadView.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(thread.title).toBe("Title");
    expect(agent.status.state).toBe("starting");
  });
  it("appends message, reasoning and shell fields, then replaces authoritative items", () => {
    const reasoning = Item.parse({
      id: "reasoning",
      agentId: "a",
      type: "reasoning",
      text: "Think",
      complete: false,
      createdAt: 1,
    });
    const shell = Item.parse({
      id: "shell",
      agentId: "a",
      type: "tool_call",
      complete: false,
      createdAt: 1,
      call: {
        id: "shell",
        agentId: "a",
        kind: "shell",
        raw: [],
        title: "Command",
        status: "running",
        startedAt: 1,
        detail: { kind: "shell", command: "pwd" },
      },
    });
    const { view } = fold([
      { type: "item.created", item: message },
      { type: "item.created", item: reasoning },
      { type: "item.created", item: shell },
      { type: "item.delta", itemId: message.id, agentId: agent.id, field: "text", append: "!" },
      {
        type: "item.delta",
        itemId: reasoning.id,
        agentId: agent.id,
        field: "reasoning",
        append: " more",
      },
      { type: "item.delta", itemId: shell.id, agentId: agent.id, field: "output", append: "/repo" },
    ]);
    expect(view.items.message).toMatchObject({ parts: [{ type: "text", text: "hello!" }] });
    expect(view.items.reasoning).toMatchObject({ text: "Think more" });
    expect(view.items.shell).toMatchObject({ call: { detail: { output: "/repo" } } });
    applyEvent(view, event(7, { type: "item.updated", item: shell }));
    expect(view.items.shell).toEqual(shell);
    expect(view.itemOrder).toHaveLength(3);
  });
  it("ignores duplicates and old sequences and refuses gaps without mutation", () => {
    const view = createThreadView(thread);
    const e = event(1, { type: "thread.updated", title: "One" });
    expect(applyEvent(view, e).kind).toBe("applied");
    expect(applyEvent(view, e).kind).toBe("ignored");
    expect(applyEvent(view, { ...e, seq: 0 }).kind).toBe("ignored");
    expect(applyEvent(view, { ...e, seq: 3 })).toEqual({ kind: "gap", expected: 2, received: 3 });
    expect(view.seq).toBe(1);
    expect(applyEvent(view, { ...e, seq: 2 }).kind).toBe("applied");
    const list = createThreadListView([thread]);
    expect(applyThreadListEvent(list, { ...e, seq: 2 }).kind).toBe("gap");
    expect(list.seq).toBe(0);
  });
  it("advances over other threads, handles unarchive and covered delta ranges", () => {
    const view = createThreadView(thread);
    const other = {
      ...event(1, { type: "thread.updated", title: "Other" }),
      threadId: Thread.parse({ ...thread, id: "other" }).id,
    };
    applyEvent(view, other);
    expect(view.thread.title).toBe("Title");
    applyEvent(view, event(2, { type: "thread.updated", archivedAt: 2 }));
    applyEvent(view, event(3, { type: "thread.updated", archivedAt: null }));
    expect(view.thread.archivedAt).toBeUndefined();
    applyEvent(view, event(4, { type: "item.created", item: message }));
    const delta = {
      ...event(8, {
        type: "item.delta",
        itemId: message.id,
        agentId: agent.id,
        field: "text",
        append: "1234",
      }),
      firstSeq: 5,
    };
    expect(applyEvent(view, delta).kind).toBe("applied");
    expect(applyEvent(view, delta).kind).toBe("ignored");
    expect(view.seq).toBe(8);
  });
  it("folds 10k deltas without scanning the transcript", () => {
    const view = createThreadView(thread);
    applyEvent(view, event(1, { type: "item.created", item: message }));
    const delta = event(2, {
      type: "item.delta",
      itemId: message.id,
      agentId: agent.id,
      field: "text",
      append: "x",
    });
    const start = performance.now();
    for (let seq = 2; seq <= 10001; seq++) applyEvent(view, { ...delta, seq });
    expect(view.items.message).toMatchObject({ parts: [{ text: "hello" + "x".repeat(10000) }] });
    expect(performance.now() - start).toBeLessThan(5000);
  });
  it("treats opaque prototype-like ids as data after a snapshot roundtrip", () => {
    const view = JSON.parse(JSON.stringify(createThreadView(thread))) as ThreadView;
    const strange = Item.parse({ ...message, id: "__proto__" });
    applyEvent(view, event(1, { type: "item.created", item: strange }));
    applyEvent(
      view,
      event(2, {
        type: "item.delta",
        itemId: strange.id,
        agentId: agent.id,
        field: "text",
        append: "!",
      }),
    );
    const encoded = JSON.parse(JSON.stringify(view)) as ThreadView;
    expect(encoded.items["__proto__"]).toMatchObject({ parts: [{ type: "text", text: "hello!" }] });
    expect(encoded.itemOrder).toEqual(["__proto__"]);
    const list = createThreadListView();
    const strangeThread = Thread.parse({ ...thread, id: "__proto__" });
    applyThreadListEvent(list, {
      ...event(1, { type: "thread.created", thread: strangeThread }),
      threadId: strangeThread.id,
    });
    expect(JSON.parse(JSON.stringify(list)).threads["__proto__"].title).toBe(thread.title);
  });
});
