import { Client } from "@ace/client";
import { DeviceId, type Item } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { LongThreadSoak, fakeTransport, multiDayThread } from "./index.ts";

/*
 * The long-thread soak serves the synthetic multi-day thread on demand. These check it answers
 * like a daemon holding the whole thread would: the same items in the same order, windows and
 * pages that join without gaps, digests and search over regenerated turns.
 */

const shape = { items: 8_000, turns: 40, subagents: 4 };
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(daemon: LongThreadSoak) {
  let id = 0;
  const client = new Client({
    deviceId: DeviceId.parse("perf-device"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    random: () => 0,
    id: () => `perf-${++id}`,
  });
  clients.push(client);
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  return client;
}

/** Every main-thread item of the generator, in order: what a full daemon would hold. */
const allItems = (): Item[] =>
  [...multiDayThread(shape)].flatMap((event) =>
    event.threadId === "thread-multi-day" && event.payload.type === "item.created"
      ? [event.payload.item]
      : [],
  );
const text = (item: Item) =>
  item.type === "message"
    ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : item.type === "notice" || item.type === "reasoning"
      ? item.text.slice(0, 40)
      : item.type === "tool_call"
        ? item.call.title
        : item.type;

test("paging back from the snapshot reaches the first item without a gap or a repeat", async () => {
  const daemon = new LongThreadSoak({ clock: () => Date.UTC(2026, 9, 3), shape });
  const client = await connect(daemon);
  const expected = allItems().map((item) => item.id);
  const lease = client.thread("thread-multi-day");
  await new Promise((resolve) => setTimeout(resolve, 10));
  let order = [...lease.store.order];
  expect(order).toEqual(expected.slice(-200));
  let before = lease.store.itemsBefore;
  const seen = [...order];
  while (typeof before === "number") {
    const page = await client.itemsPage({ threadId: "thread-multi-day", before, limit: 200 });
    order = page.items.map((item) => item.id);
    seen.unshift(...order);
    before = page.itemsBefore;
  }
  lease.release();
  expect(seen).toEqual(expected);
});

test("a window around a turn starts at its ask and slides on without gaps", async () => {
  const daemon = new LongThreadSoak({ clock: () => 0, shape });
  const client = await connect(daemon);
  const expected = allItems();
  const window = await client.itemsWindow({
    threadId: "thread-multi-day",
    turnOrdinal: 7,
    before: 10,
    after: 189,
  });
  const target = window.items.find((item) => window.itemSeqs[item.id] === window.targetSeq);
  expect(target && text(target)).toBe("Migrate checkpoint 7, inspect files and report failures.");
  const at = expected.findIndex((item) => item.id === window.items[0]?.id);
  expect(window.items.map((item) => item.id)).toEqual(
    expected.slice(at, at + 200).map((item) => item.id),
  );
  if (window.itemsAfter === null) throw new Error("Expected newer items");
  const next = await client.itemsWindow({
    threadId: "thread-multi-day",
    aroundSeq: window.itemsAfter + 1,
    before: 0,
    after: 99,
  });
  expect(next.items[0]?.id).toBe(expected[at + 200]?.id);
});

test("turn pages carry each turn's digest, and catch-up merges the turns after a cursor", async () => {
  const daemon = new LongThreadSoak({ clock: () => 0, shape });
  const client = await connect(daemon);
  const page = await client.turnsPage({ threadId: "thread-multi-day", before: 23, limit: 2 });
  expect(page.turns.map((turn) => turn.ordinal)).toEqual([21, 22]);
  expect(page.before).toBe(21);
  const failing = page.turns[1];
  // Every eleventh checkpoint's inspection fails; each turn asks one approval.
  expect(failing?.digest).toMatchObject({
    commandsRun: 3,
    commandsFailed: 1,
    approvalsAsked: 1,
    approvalsAnswered: 1,
  });
  expect(page.turns[0]?.digest.commandsFailed).toBe(0);
  expect(failing?.initiatingMessagePreview).toBe(
    "Migrate checkpoint 22, inspect files and report failures.",
  );

  const from = await client.turnsPage({ threadId: "thread-multi-day", before: 39, limit: 1 });
  const catchUp = await client.threadCatchUp({
    threadId: "thread-multi-day",
    sinceSeq: from.turns[0]?.endSeq ?? 0,
  });
  expect(catchUp.turnsCompleted).toBe(2);
  expect(catchUp.digest.approvalsAnswered).toBe(2);
  expect(catchUp.latestAgentMessagePreview).toContain("Checkpoint 40 completed.");
});

test("search reads tool output and subagent threads, and continues past sparse pages", async () => {
  const daemon = new LongThreadSoak({ clock: () => 0, shape });
  const client = await connect(daemon);
  // The needle is only in turn 33's streamed command output, past several request budgets.
  let cursor: string | undefined;
  const hits = [];
  for (let reads = 0; reads < 10; reads++) {
    const page = await client.threadSearch({
      threadId: "thread-multi-day",
      text: "tool-output-needle-33",
      ...(cursor ? { cursor } : {}),
    });
    hits.push(...page.hits);
    if (page.cursor === null) break;
    cursor = page.cursor;
  }
  expect(hits.map((hit) => hit.turnOrdinal)).toEqual([33]);
  expect(hits[0]?.snippet.text).toContain("tool-output-needle-33");

  const alone = await client.threadSearch({
    threadId: "thread-multi-day",
    text: "subagent-needle",
  });
  expect(alone.hits).toEqual([]);
  const tree = await client.threadSearch({
    threadId: "thread-multi-day",
    text: "subagent-needle",
    scope: "tree",
  });
  expect(tree.hits.map((hit) => hit.threadId)).toEqual([
    "thread-multi-day.child.1",
    "thread-multi-day.child.2",
    "thread-multi-day.child.3",
    "thread-multi-day.child.4",
  ]);
});

test("live items follow the synthetic turns and count in the turn index", async () => {
  const daemon = new LongThreadSoak({ clock: () => 0, shape });
  const client = await connect(daemon);
  const lease = client.thread("thread-multi-day");
  await new Promise((resolve) => setTimeout(resolve, 10));
  daemon.pump(5);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const newest = lease.store.order.slice(-5).map((id) => lease.store.item(id));
  expect(newest.map((item) => (item?.type === "notice" ? item.text : item?.type))).toEqual(
    [1, 2, 3, 4, 5].map(
      (n) => `Live checkpoint 41, finding ${n}: replay window holds after the resume.`,
    ),
  );
  lease.release();
  const page = await client.turnsPage({ threadId: "thread-multi-day", limit: 1 });
  expect(page.turns[0]).toMatchObject({ ordinal: 41, outcome: "active" });
});
