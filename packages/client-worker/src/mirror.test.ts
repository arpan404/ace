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
  const deliver = (payload: EventPayload) => {
    seq += 1;
    store.delivery({
      type: "events",
      subscriptionId: "thread",
      afterSeq: seq - 1,
      throughSeq: seq,
      events: [Event.parse({ id: `e${seq}`, threadId: thread.id, seq, at: 0, payload })],
    });
  };
  return { store, mirror, deliver, forwarded };
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
