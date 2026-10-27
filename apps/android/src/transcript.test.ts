import { expect, it } from "vitest";
import { defaultLimits, ThreadStore } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Agent, Event, Item, Run, Thread, type Item as ItemType } from "@ace/protocol";
import { createBlockReader } from "@ace/ui-core/transcript-block-reader";
import { buildBlocks, blockItems, type BlockSource } from "@ace/ui-core/transcript-blocks";
import { blockTestId, endBlockText, forkedBlockText, startedBlockText } from "./transcript.ts";

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
  extra: Record<string, unknown> = {},
): ItemType {
  return Item.parse({
    id,
    agentId: "root",
    runId: "run-1",
    createdAt,
    complete: true,
    type: "message",
    role,
    parts: [{ type: "text", text }],
    ...(role === "user" ? { origin: { kind: "person", commandId: `send-${id}` } } : {}),
    ...extra,
  });
}

function source(items: ItemType[]): BlockSource {
  const byId = new Map<string, ItemType>(items.map((item) => [item.id as string, item]));
  return {
    order: items.map((item) => item.id),
    item: (id) => byId.get(id),
    background: new Map(),
    run: () => ({ state: "completed", trigger: "user" }),
  };
}

it("groups a user ask and an assistant answer into distinct user/message blocks", () => {
  const blocks = buildBlocks(
    source([
      message("ask", "user", "What changed?", 1),
      message("answer", "assistant", "Two files.", 2),
    ]),
  );
  expect(blocks.map((block) => block.kind)).toEqual(["user", "message"]);
  expect(blockTestId(blocks[0]!)).toBe("transcript.user");
  expect(blockTestId(blocks[1]!)).toBe("transcript.answer");
  expect(blockItems(blocks[0]!)).toEqual(["ask"]);
  expect(blockItems(blocks[1]!)).toEqual(["answer"]);
});

it("renders a synthetic injected message as an event block, never a bubble", () => {
  const blocks = buildBlocks(
    source([
      message("ask", "user", "Go", 1),
      message("injected", "assistant", "Context compacted", 2, { synthetic: true }),
      message("answer", "assistant", "Done.", 3),
    ]),
  );
  const kinds = blocks.map((block) => block.kind);
  expect(kinds).toContain("event");
  const event = blocks.find((block) => block.kind === "event")!;
  expect(blockTestId(event)).toBe("transcript.event");
  expect(blockItems(event)).toEqual(["injected"]);
});

it("keeps block identity across a streaming text delta", () => {
  const first = buildBlocks(source([message("ask", "user", "Go", 1)]));
  const second = buildBlocks(
    source([
      message("ask", "user", "Go", 1),
      Item.parse({
        id: "answer",
        agentId: "root",
        runId: "run-1",
        createdAt: 2,
        complete: false,
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "Par" }],
      }),
    ]),
  );
  expect(second.map((block) => block.kind)).toEqual(["user", "message"]);
  expect(second[0]!.key).toBe(first[0]!.key);
});

it("words turn endings, handoff-adjacent fork dividers and started threads canonically", () => {
  expect(
    endBlockText({ kind: "end", key: "e1", ending: "interrupted", runId: "r", askId: "a" }),
  ).toBe("Interrupted by you");
  expect(
    endBlockText({
      kind: "end",
      key: "e2",
      ending: "interrupted",
      runId: "r",
      askId: "a",
      automatic: true,
    }),
  ).toBe("Interrupted");
  expect(endBlockText({ kind: "end", key: "e3", ending: "failed", runId: "r", askId: "a" })).toBe(
    "Turn failed",
  );
  expect(endBlockText({ kind: "end", key: "e4", ending: "paused", runId: "r", askId: "a" })).toBe(
    "Paused — will resume",
  );
  expect(forkedBlockText("source-1")).toBe("Forked from earlier conversation");
  expect(forkedBlockText("source-1", "Billing thread")).toBe("Forked from Billing thread");
  expect(startedBlockText()).toBe("Started a new thread");
  expect(startedBlockText("Billing fix")).toBe("Started Billing fix");
});

function liveCourt(threadId: string, askId: string) {
  const thread = Thread.parse({
    id: threadId,
    workspaceId: "workspace",
    provider: "codex",
    title: threadId,
    rootAgentId: "root",
    status: { state: "working", agents: 1 },
    createdAt: 0,
    updatedAt: 0,
  });
  const store = new ThreadStore(defaultLimits);
  const view = createThreadView(thread);
  view.agents["root"] = Agent.parse({
    id: "root",
    threadId,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/",
    createdAt: 0,
    status: { state: "idle" },
  });
  view.runs["run-1"] = Run.parse({
    id: "run-1",
    agentId: "root",
    threadId,
    trigger: "user",
    state: "active",
    startedAt: 1,
  });
  const ask = Item.parse({
    id: askId,
    agentId: "root",
    runId: "run-1",
    createdAt: 1,
    complete: true,
    type: "message",
    role: "user",
    parts: [{ type: "text", text: "Go" }],
    origin: { kind: "person", commandId: `send-${askId}` },
  });
  const step = Item.parse({
    id: `step-${threadId}`,
    agentId: "root",
    runId: "run-1",
    createdAt: 2,
    complete: true,
    type: "reasoning",
    text: "thinking",
  });
  const answer = Item.parse({
    id: `answer-${threadId}`,
    agentId: "root",
    runId: "run-1",
    createdAt: 3,
    complete: false,
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: "Par" }],
  });
  view.items = { [ask.id]: ask, [step.id]: step, [answer.id]: answer };
  view.itemOrder = [ask.id, step.id, answer.id];
  store.snapshot(view);
  let seq = 0;
  const deliver = (payload: unknown) => {
    seq += 1;
    store.delivery({
      type: "events",
      subscriptionId: "s",
      afterSeq: seq - 1,
      throughSeq: seq,
      events: [Event.parse({ id: `event-${seq}`, seq, at: seq, threadId, payload })],
    });
  };
  return { store, deliver };
}

it("watches the active run so a text delta never regroups the transcript", () => {
  const { store, deliver } = liveCourt("thread-delta", "ask-delta");
  const read = createBlockReader();
  const first = read(store);
  expect(first.value.some((block) => block.kind === "live")).toBe(true);
  // The stale-subscription regression: without this key the hook would never
  // re-run the reader when the run ends.
  expect(first.watch).toContain("run:run-1");
  deliver({
    type: "item.delta",
    itemId: "answer-thread-delta",
    agentId: "root",
    field: "text",
    append: "tial",
  });
  expect(read(store).value).toBe(first.value);
});

it("settles the live line into a work head once the turn's run ends", () => {
  const { store, deliver } = liveCourt("thread-live", "ask-live");
  const read = createBlockReader();
  const live = read(store);
  expect(live.value.some((block) => block.kind === "live")).toBe(true);
  deliver({ type: "run.ended", runId: "run-1", state: "completed", endedAt: 4 });
  deliver({ type: "thread.updated", status: { state: "done" } });
  const settled = read(store);
  expect(settled.value).not.toBe(live.value);
  expect(settled.value.some((block) => block.kind === "live")).toBe(false);
  expect(settled.value.some((block) => block.kind === "work" && block.itemIds.length > 0)).toBe(
    true,
  );
});

it("does not carry one thread's turn keys into another thread", () => {
  const a = liveCourt("thread-a", "ask-a");
  const b = liveCourt("thread-b", "ask-b");
  const shared = createBlockReader();
  const aBlocks = shared(a.store).value;
  expect(aBlocks.some((block) => block.kind === "live")).toBe(true);
  // One reader serves one thread: sharing it reuses thread A's ask key for
  // thread B's turn, so the hook creates a fresh reader per store.
  const staleKeys = shared(b.store).value.map((block) => block.key);
  expect(staleKeys).toContain("work:ask-a");
  const fresh = createBlockReader();
  const bBlocks = fresh(b.store).value;
  const bKeys = bBlocks.map((block) => block.key);
  expect(bKeys).toContain("work:ask-b");
  expect(bKeys).not.toContain("work:ask-a");
  expect(fresh(b.store).value).toBe(bBlocks);
});
