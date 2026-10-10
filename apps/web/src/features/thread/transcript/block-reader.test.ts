import { ThreadStore, defaultLimits, type ThreadReader } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Agent, Event, Interaction, Item, Run, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { createBlockReader } from "./block-reader.ts";

function transcript(count: number) {
  const items = new Map<string, Item>();
  for (let n = 0; n < count; n++) {
    const id = `message-${n}`;
    items.set(
      id,
      Item.parse({
        id,
        agentId: "root",
        createdAt: n,
        complete: true,
        type: "message",
        role: "user",
        parts: [{ type: "text", text: id }],
      }),
    );
  }
  let questions: Interaction[] = [];
  let reads = 0;
  const reader: ThreadReader = {
    thread: undefined,
    error: undefined,
    queue: undefined,
    context: undefined,
    cursor: undefined,
    itemsBefore: undefined,
    order: [...items.keys()],
    item(id) {
      reads++;
      return items.get(id);
    },
    run: () => undefined,
    agent: () => undefined,
    task: () => undefined,
    interactionIds: () => questions.map((q) => q.id),
    interaction: (id) => questions.find((q) => q.id === id),
    agentIds: () => [],
    children: () => [],
    taskIds: () => [],
    usage: () => undefined,
    contextMeter: () => undefined,
    usageSnapshot: () => undefined,
    truncated: () => false,
  };
  return {
    reader,
    resetReads: () => {
      reads = 0;
    },
    reads: () => reads,
    replaceQuestion(id: string) {
      questions = [
        Interaction.parse({
          id,
          threadId: "thread",
          agentId: "root",
          createdAt: 10,
          blocking: true,
          state: "pending",
          request: { kind: "question", questions: [] },
        }),
      ];
    },
  };
}

test("unchanged notifications do not scan a long settled transcript again", () => {
  const source = transcript(5_000);
  const read = createBlockReader();
  const first = read(source.reader);
  source.resetReads();
  for (let n = 0; n < 10; n++) expect(read(source.reader).value).toBe(first.value);
  expect(source.reads()).toBe(0);
});

test("replacing a question with the same count updates its transcript block", () => {
  const source = transcript(1);
  const read = createBlockReader();
  source.replaceQuestion("first");
  expect(read(source.reader).value).toContainEqual(
    expect.objectContaining({ kind: "question", interactionId: "first" }),
  );
  source.replaceQuestion("replacement");
  const blocks = read(source.reader).value;
  expect(blocks).toContainEqual(
    expect.objectContaining({ kind: "question", interactionId: "replacement" }),
  );
  expect(blocks).not.toContainEqual(
    expect.objectContaining({ kind: "question", interactionId: "first" }),
  );
});

function settledTree(link: "agent" | "spawn") {
  const thread = Thread.parse({
    id: "tree",
    workspaceId: "workspace",
    provider: "codex",
    title: "Tree",
    rootAgentId: "root",
    status: { state: "done" },
    createdAt: 0,
    updatedAt: 10,
  });
  const view = createThreadView(thread);
  for (const id of ["root", "child"])
    view.agents[id] = Agent.parse({
      id,
      threadId: thread.id,
      parentId: id === "root" ? null : "root",
      origin: id === "root" ? "root" : "provider_subagent",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: "/",
      createdAt: 0,
      status: { state: "idle" },
      ...(id === "child" && link === "spawn" ? { spawnedBy: "spawn" } : {}),
    });
  for (const [id, agentId] of [
    ["first", "root"],
    ["second", "root"],
    ["child-run", "child"],
  ] as const)
    view.runs[id] = Run.parse({
      id,
      agentId,
      threadId: thread.id,
      trigger: "user",
      state: "completed",
      startedAt: 0,
      endedAt: 10,
    });
  const spawn = Item.parse({
    id: "spawn",
    agentId: "root",
    createdAt: 0,
    complete: true,
    ...(link === "agent" ? { runId: "first" } : {}),
    type: "tool_call",
    call: {
      id: "spawn",
      agentId: "root",
      kind: "agent.spawn",
      title: "Start child",
      status: "succeeded",
      detail: { kind: "agent.spawn" },
      startedAt: 0,
      endedAt: 1,
      raw: [],
    },
  });
  view.items[spawn.id] = spawn;
  for (const [index, id] of ["second-before", "child-output", "second-after"].entries())
    view.items[id] = Item.parse({
      id,
      agentId: id === "child-output" ? "child" : "root",
      runId: id === "child-output" ? "child-run" : "second",
      createdAt: index + 1,
      complete: true,
      type: "reasoning",
      text: id,
    });
  view.itemOrder = ["spawn", "second-before", "child-output", "second-after"];
  const store = new ThreadStore(defaultLimits);
  store.snapshot(view);
  return {
    store,
    spawn,
    update(payload: unknown) {
      const seq = (store.cursor ?? 0) + 1;
      store.delivery({
        type: "events",
        subscriptionId: "tree",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [Event.parse({ id: `event-${seq}`, threadId: thread.id, seq, at: 10, payload })],
      });
    },
  };
}

test.each(["agent", "spawn"] as const)(
  "a settled child's late %s link regroups its work",
  (link) => {
    const source = settledTree(link);
    const read = createBlockReader();
    const before = read(source.store);
    const work = (blocks: typeof before.value) =>
      blocks.filter((block) => block.kind === "work").map((block) => block.itemIds);
    expect(work(before.value)).toEqual([["second-before", "child-output", "second-after"]]);
    const order = source.store.order;
    source.update(
      link === "agent"
        ? { type: "agent.updated", agentId: "child", spawnedBy: "spawn" }
        : { type: "item.updated", item: { ...source.spawn, runId: "first" } },
    );
    expect(source.store.order).toBe(order);
    const after = read(source.store);
    expect(work(after.value)).toEqual([["second-before"], ["child-output"], ["second-after"]]);
    expect(before.watch).toContain("agent:child");
    if (link === "spawn") expect(before.watch).toContain("item:spawn");
    expect(after.value).toEqual(createBlockReader()(source.store).value);
    expect(after.watch).toContain("item:spawn");
    source.update({
      type: "item.updated",
      item: { ...source.store.item("child-output"), text: "More reasoning" },
    });
    expect(read(source.store).value).toBe(after.value);
  },
);
