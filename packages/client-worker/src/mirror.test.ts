import { ThreadStore, defaultLimits } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { AgentId, Event, Thread, type EventPayload, type Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { MirrorThread } from "./mirror.ts";
import { threadPatches } from "./patches.ts";

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Queue and context",
  status: { state: "done" },
  createdAt: 0,
  updatedAt: 0,
  rootAgentId: "root",
});

/** A worker-side store and a tab's mirror of it, linked the way the host links them. */
function linked() {
  const store = new ThreadStore(defaultLimits);
  store.snapshot(createThreadView(thread));
  const mirror = new MirrorThread(defaultLimits.listeners);
  mirror.reset(store.export());
  const sent = new Map<string, Item>();
  const forwarded: number[] = [];
  store.observe((keys) => {
    const patches = threadPatches(store, keys, sent);
    forwarded.push(JSON.stringify(patches).length);
    mirror.apply(patches);
  });
  let seq = 0;
  /** Deliver `payloads` in one socket message: the tab hears of them in one flush. */
  const deliverAll = (payloads: readonly EventPayload[]) => {
    const afterSeq = seq;
    const events = payloads.map((payload) => {
      seq += 1;
      return Event.parse({ id: `e${seq}`, threadId: thread.id, seq, at: 0, payload });
    });
    store.delivery({ type: "events", subscriptionId: "thread", afterSeq, throughSeq: seq, events });
  };
  const deliver = (payload: EventPayload) => deliverAll([payload]);
  return { store, mirror, deliver, deliverAll, forwarded };
}

const meter = (usedTokens: number) => ({
  type: "context_meter.updated" as const,
  meter: {
    agentId: AgentId.parse("root"),
    usedTokens,
    windowTokens: 128000,
    epoch: 1,
    source: "provider" as const,
  },
});

test("a tab sees the root agent's context meter fill as the worker's store does", () => {
  const { mirror, deliver } = linked();
  const context = mirror.select(["context:root"], (reader) => reader.context?.usedTokens);
  const heard: unknown[] = [];
  const stop = context.subscribe(() => heard.push(context.getSnapshot()));
  deliver(meter(12000));
  deliver(meter(40000));
  expect(heard).toEqual([12000, 40000]);
  stop();
});

test("a tab sees the queue pause and its revision without a fresh snapshot", () => {
  const { store, mirror, deliver } = linked();
  const queue = mirror.select(["queue"], (reader) => reader.queue);
  deliver({ type: "queue.updated", revision: 3, paused: true, reason: "restart", resumeAt: null });
  expect(queue.getSnapshot()).toMatchObject({ revision: 3, paused: true });
  expect(queue.getSnapshot()).toEqual(store.queue);
});

test("a tab attaching later starts from the worker's queue and context meters", () => {
  const { store, deliver } = linked();
  deliver(meter(9000));
  deliver({ type: "queue.updated", revision: 2, paused: false, reason: null, resumeAt: null });
  const late = new MirrorThread(defaultLimits.listeners);
  late.reset(structuredClone(store.export()));
  expect(late.context?.usedTokens).toBe(9000);
  expect(late.queue).toEqual(store.queue);
});

test("streaming reasoning reaches a tab as the text it gained, not the whole text each frame", () => {
  const { store, mirror, deliver, forwarded } = linked();
  deliver({
    type: "item.created",
    item: {
      id: "think",
      agentId: "root",
      type: "reasoning",
      text: "",
      createdAt: 0,
      complete: false,
    },
  } as EventPayload);
  const chunk = "Comparing the replay cursor against the acked sequence. ".repeat(4);
  for (let n = 0; n < 200; n++)
    deliver({
      type: "item.delta",
      itemId: "think",
      agentId: "root",
      field: "reasoning",
      append: chunk,
    } as EventPayload);
  const item = mirror.item("think");
  expect(item?.type === "reasoning" && item.text).toBe(chunk.repeat(200));
  expect(mirror.item("think")).toEqual(store.item("think"));
  // Each frame carries about one chunk, though the text grew to 45 KB.
  expect(Math.max(...forwarded.slice(-50))).toBeLessThan(chunk.length + 400);
});

/** The assistant answer the streaming tests follow. */
const answer = (text: string) =>
  ({
    type: "message" as const,
    id: "answer",
    agentId: "root",
    role: "assistant" as const,
    synthetic: false,
    createdAt: 0,
    complete: false,
    parts: [{ type: "text" as const, text }],
  }) as Item;
/** The text of a message's first part. */
const text = (item: Item | undefined) =>
  item?.type === "message" && item.parts[0]?.type === "text" ? item.parts[0].text : undefined;
/** The `n`th 240-character delta of the long answer. */
const delta = (n: number) =>
  ({
    type: "item.delta",
    itemId: "long",
    agentId: "root",
    field: "text",
    append: `${String(n).padStart(4, "0")} ${"x".repeat(234)}\n`,
  }) as EventPayload;

test("a streaming answer reaches a tab as the text it gained; a rewrite of it arrives whole", () => {
  const { store, mirror, deliver, forwarded } = linked();
  deliver({ type: "item.created", item: answer("") } as EventPayload);
  const chunk = "The replay window caps at 200 events per shard. ".repeat(4);
  for (let n = 0; n < 200; n++)
    deliver({
      type: "item.delta",
      itemId: "answer",
      agentId: "root",
      field: "text",
      append: chunk,
    } as EventPayload);
  expect(text(mirror.item("answer"))).toBe(chunk.repeat(200));
  // Each frame carries about one chunk, though the answer grew to 38 KB.
  expect(Math.max(...forwarded.slice(-50))).toBeLessThan(chunk.length + 400);
  // The provider resends the answer corrected: longer, and different early on.
  const corrected = `Corrected. ${chunk.repeat(200)}`;
  deliver({ type: "item.updated", item: answer(corrected) } as EventPayload);
  expect(text(mirror.item("answer"))).toBe(corrected);
  expect(text(mirror.item("answer"))).toBe(text(store.item("answer")));
});

test("an answer cut to the client's text limit mid-stream reaches a tab exactly as the worker holds it", () => {
  const { store, mirror, deliver, deliverAll } = linked();
  deliver({
    type: "item.created",
    item: {
      type: "message",
      id: "long",
      agentId: "root",
      role: "assistant",
      synthetic: false,
      createdAt: 0,
      complete: false,
      parts: [{ type: "text", text: "" }],
    },
  } as EventPayload);
  // 270 chunks of 240 characters: just under the 64 K limit, one frame each.
  for (let n = 0; n < 270; n++) deliver(delta(n));
  // Then one frame that passes the limit (the client keeps the newest 32 K) and grows the text
  // back past the length the tab last saw: 32,768 + 134 × 240 = 64,928 characters.
  deliverAll(Array.from({ length: 138 }, (_, n) => delta(270 + n)));
  expect(mirror.item("long")).toEqual(store.item("long"));
  expect(mirror.truncated("long")).toBe(true);
});
