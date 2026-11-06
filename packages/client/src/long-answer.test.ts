import { Event, Item, Thread, type ThreadView } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { expect, test } from "vitest";
import { defaultLimits, ThreadStore } from "./index.ts";

/*
 * A long answer, as the client holds it: bounded to its newest text, and still moving when the
 * daemon sent only a preview of it.
 */

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Long answer",
  rootAgentId: "root",
  status: { state: "done" },
  createdAt: 0,
  updatedAt: 0,
});
const answer = (text: string, source?: object) =>
  Item.parse({
    id: "answer",
    agentId: "root",
    type: "message",
    role: "assistant",
    createdAt: 1,
    complete: false,
    parts: [{ type: "text", text, ...(source ? { source } : {}) }],
  });
function opened(item: Item, limits = defaultLimits) {
  const store = new ThreadStore(limits);
  const view: ThreadView = createThreadView(thread, 10);
  view.items = { [item.id]: item };
  view.itemOrder = [item.id];
  view.itemSeqs = { [item.id]: 1 };
  store.snapshot(view);
  let seq = 10;
  const stream = (append: string) => {
    seq++;
    store.delivery({
      type: "events",
      subscriptionId: "s",
      afterSeq: seq - 1,
      throughSeq: seq,
      events: [
        Event.parse({
          id: `event-${seq}`,
          seq,
          at: seq,
          threadId: thread.id,
          payload: { type: "item.delta", itemId: "answer", agentId: "root", field: "text", append },
        }),
      ],
    });
  };
  const text = () => {
    const held = store.item("answer");
    const part = held?.type === "message" ? held.parts.at(-1) : undefined;
    return part?.type === "text" ? part : undefined;
  };
  return { store, stream, text };
}
const step = (n: number) => ` Step ${n}: wire the filters.`;

test("an answer longer than the bound keeps showing its latest text", () => {
  const limit = 256;
  const { store, stream, text } = opened(answer("Start."), { ...defaultLimits, text: limit });
  let whole = "Start.";
  for (let n = 1; n <= 60; n++) {
    stream(step(n));
    whole += step(n);
    // Always the newest `limit` units: never half of them, never stale.
    expect(text()?.text).toBe(whole.slice(-limit));
  }
  expect(store.truncated("answer")).toBe(true);
});

test("a thread opened mid-answer keeps updating as deltas arrive", () => {
  const whole = "x".repeat(10_000) + " the newest words";
  const tail = whole.slice(-4096);
  const { stream, text } = opened(
    answer(tail, {
      streamId: "text:answer",
      bytes: whole.length * 2,
      encoding: "utf-16le",
      offset: (whole.length - tail.length) * 2,
    }),
  );
  stream(" and more");
  stream(" still more");
  expect(text()?.text).toBe(tail + " and more still more");
  expect(text()?.source).toMatchObject({
    bytes: (whole.length + " and more still more".length) * 2,
    offset: (whole.length - tail.length) * 2,
  });
});

test("an unmarked preview from an older daemon still shows", () => {
  // An older daemon sends a preview's head with no offset: it stays on screen, unchanged by
  // deltas it cannot be extended with, and the source keeps counting the whole text.
  const whole = "Head of the answer. " + "y".repeat(9_000);
  const head = whole.slice(0, 4096);
  const { store, stream, text } = opened(
    answer(head, { streamId: "text:answer", bytes: whole.length * 2, encoding: "utf-16le" }),
  );
  stream(" more");
  expect(text()?.text).toBe(head);
  expect(text()?.source?.bytes).toBe((whole.length + 5) * 2);
  expect(store.truncated("answer")).toBe(true);
});

test("a preview cut to the client's bound says where its text now starts", () => {
  const whole = "z".repeat(20_000);
  const tail = whole.slice(-16_384);
  const limit = 8192;
  const { stream, text } = opened(
    answer(tail, {
      streamId: "text:answer",
      bytes: whole.length * 2,
      encoding: "utf-16le",
      offset: (whole.length - tail.length) * 2,
    }),
    { ...defaultLimits, text: limit },
  );
  expect(text()?.text).toHaveLength(limit);
  expect(text()?.source?.offset).toBe((whole.length - limit) * 2);
  stream("!");
  expect(text()?.text).toBe(whole.slice(-(limit - 1)) + "!");
  expect(text()?.source).toMatchObject({
    bytes: (whole.length + 1) * 2,
    offset: (whole.length + 1 - limit) * 2,
  });
});
