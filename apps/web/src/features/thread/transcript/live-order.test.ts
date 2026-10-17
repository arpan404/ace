import { defaultLimits, ThreadStore } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Event, Item, Thread, type EventPayload, type ThreadView } from "@ace/protocol";
import { expect, test } from "vitest";
import { createBlockReader } from "./block-reader.ts";
import { buildBlocks } from "./blocks.ts";

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Live order",
  rootAgentId: "root",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const message = (id: string, role: "user" | "assistant", createdAt: number) =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role,
    createdAt,
    complete: true,
    parts: [{ type: "text", text: id }],
  });

test.each([
  { changed: "ask", initial: "live", timestamp: 20 },
  { changed: "answer", initial: "live", timestamp: 30 },
  { changed: "ask", initial: "snapshot", timestamp: 10 },
  { changed: "answer", initial: "snapshot", timestamp: 10 },
])(
  "updates to $changed retain admitted prompt order after $initial admission",
  ({ changed, initial, timestamp }) => {
    const store = new ThreadStore(defaultLimits);
    store.snapshot(createThreadView(thread));
    let seq = 0;
    const deliver = (type: "item.created" | "item.updated", item: Item) => {
      const afterSeq = seq++;
      store.delivery({
        type: "events",
        subscriptionId: "s",
        afterSeq,
        throughSeq: seq,
        events: [
          Event.parse({
            id: `event-${seq}`,
            seq,
            at: seq,
            threadId: thread.id,
            payload: { type, item },
          }),
        ],
      });
    };
    const first = message("first", "user", 10);
    const ask = message("ask", "user", timestamp);
    const answer = message("answer", "assistant", timestamp === 10 ? 10 : 30);
    if (initial === "snapshot") {
      const view = createThreadView(thread, 3);
      view.items = { first, ask, answer };
      view.itemOrder = ["first", "ask", "answer"];
      view.itemSeqs = { first: 1, ask: 2, answer: 3 };
      store.snapshot(view);
      seq = 3;
    } else {
      for (const item of [first, ask, answer]) deliver("item.created", item);
    }
    const visible = () =>
      buildBlocks({
        order: store.order,
        item: (id) => store.item(id),
        background: new Map(),
      }).flatMap((block) => ("itemId" in block ? [block.itemId] : []));
    expect(visible()).toEqual(["first", "ask", "answer"]);
    deliver(
      "item.updated",
      Item.parse({
        ...(changed === "ask" ? ask : answer),
        createdAt: changed === "ask" ? 40 : 0,
        parts: [{ type: "text", text: "Updated content" }],
      }),
    );
    expect(store.order).toEqual(["first", "ask", "answer"]);
    expect(visible()).toEqual(["first", "ask", "answer"]);
    expect(store.item(changed)).toMatchObject({ parts: [{ text: "Updated content" }] });
  },
);

const say = (id: string, createdAt: number, agentId = "root") =>
  Item.parse({
    id,
    agentId,
    type: "message",
    role: id.startsWith("ask") ? "user" : "assistant",
    createdAt,
    complete: true,
    parts: [{ type: "text", text: id }],
  });
function windowOf(seq: number, entries: [Item, number][], itemsBefore: number | null): ThreadView {
  const view = createThreadView(thread, seq);
  view.items = Object.fromEntries(entries.map(([item]) => [item.id, item]));
  view.itemOrder = entries.map(([item]) => item.id);
  view.itemSeqs = Object.fromEntries(entries.map(([item, at]) => [item.id, at]));
  view.itemsBefore = itemsBefore;
  return view;
}
function admit(store: ThreadStore, seq: number, payload: EventPayload) {
  store.delivery({
    type: "events",
    subscriptionId: "s",
    afterSeq: seq - 1,
    throughSeq: seq,
    events: [Event.parse({ id: `event-${seq}`, seq, at: seq, threadId: thread.id, payload })],
  });
}
/** Root items in transcript order, as the thread screen builds them; a live log holds its replies. */
function rootRows(store: ThreadStore): string[] {
  return createBlockReader()(store).value.flatMap((block) =>
    "itemId" in block && block.itemId !== undefined
      ? [block.itemId]
      : block.kind === "work"
        ? block.itemIds
        : [],
  );
}

test("timestamps that disagree with creation order never reorder the transcript", () => {
  // Creation order ask-1, answer-1, ask-2, answer-2; imported timestamps run backwards.
  const [ask1, answer1, ask2, answer2] = [
    say("ask-1", 40),
    say("answer-1", 30),
    say("ask-2", 20),
    say("answer-2", 10),
  ];
  if (!ask1 || !answer1 || !ask2 || !answer2) throw new Error("fixture");
  const expected = ["ask-1", "answer-1", "ask-2", "answer-2"];
  const store = new ThreadStore(defaultLimits);
  // Snapshot of the newest two, live append, then the older page.
  store.snapshot(
    windowOf(
      10,
      [
        [answer1, 2],
        [ask2, 3],
      ],
      2,
    ),
  );
  admit(store, 11, { type: "item.created", item: answer2 });
  store.page(
    { seq: 11, threadId: thread.id, items: [ask1], itemSeqs: { "ask-1": 1 }, itemsBefore: null },
    2,
  );
  expect(rootRows(store)).toEqual(expected);
  // A reconnect's resnapshot holds the same items in the same order.
  store.snapshot(
    windowOf(
      11,
      [
        [ask1, 1],
        [answer1, 2],
        [ask2, 3],
        [answer2, 11],
      ],
      null,
    ),
  );
  expect(rootRows(store)).toEqual(expected);
});

test("a busy subagent does not push the root prompt and reply out of the root transcript", () => {
  const store = new ThreadStore({ ...defaultLimits, items: 6 });
  store.snapshot(
    windowOf(
      2,
      [
        [say("ask", 1), 1],
        [say("reply", 2), 2],
      ],
      null,
    ),
  );
  for (let seq = 3; seq <= 30; seq++)
    admit(store, seq, { type: "item.created", item: say(`step-${seq}`, seq, "sub") });
  expect(rootRows(store)).toEqual(["ask", "reply"]);
  admit(store, 31, { type: "item.created", item: say("answer", 31) });
  expect(rootRows(store)).toEqual(["ask", "reply", "answer"]);
});
