import { afterEach, expect, test } from "vitest";
import {
  AgentId,
  ClientMessage,
  ItemId,
  RunId,
  type EventPayload,
  type Item,
  type ThreadId,
} from "@ace/protocol";
import { setup, ready, when, itemText } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const root = AgentId.parse("history-root");
const message = (id: string, role: "user" | "assistant", text = id): EventPayload => ({
  type: "item.created",
  item: {
    type: "message",
    id: ItemId.parse(id),
    agentId: root,
    role,
    createdAt: 1,
    complete: true,
    synthetic: false,
    raw: [],
    parts: [{ type: "text", text }],
  },
});
/** A root turn: the person's prompt, a run, `size` replies. */
function turn(threadId: ThreadId, ordinal: number, size: number): EventPayload[] {
  const runId = RunId.parse(`run-${ordinal}`);
  return [
    message(`prompt-${ordinal}`, "user"),
    {
      type: "run.started",
      run: {
        id: runId,
        threadId,
        agentId: root,
        ordinal,
        trigger: "user",
        state: "active",
        startedAt: ordinal,
      },
    },
    ...Array.from({ length: size }, (_, n) => message(`reply-${ordinal}-${n}`, "assistant")),
    { type: "run.ended", runId, state: "completed", endedAt: ordinal },
  ];
}
function rootAgent(threadId: ThreadId, cwd: string): EventPayload {
  return {
    type: "agent.created",
    agent: {
      id: root,
      threadId,
      parentId: null,
      origin: "root",
      fidelity: "full",
      native: { provider: "codex" },
      cwd,
      status: { state: "idle" },
      createdAt: 1,
      background: false,
    },
  };
}
const turnOf = (item: Item) => Number(item.id.split("-")[1]);

// Mutation cases: cutting at a page's item count instead of a turn start; dropping the turn
// whose prompt is the page's first item; cutting a turn larger than the page to nothing.
test("older pages never split a turn", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const sizes = [5, 40, 3, 90, 12, 300, 7, 60, 25, 2, 130, 9];
  h.daemon.store.appendEvents(h.thread.id, [rootAgent(h.thread.id, h.directory)]);
  for (const [index, size] of sizes.entries())
    h.daemon.store.appendEvents(h.thread.id, turn(h.thread.id, index + 1, size));
  const { client } = h.make();
  await ready(client);
  const all = sizes.reduce((total, size) => total + size + 1, 0);
  // Read back from the newest item a page at a time, as the history view does.
  const newest = await client.itemsWindow({
    threadId: h.thread.id,
    itemId: ItemId.parse(`reply-${sizes.length}-${(sizes.at(-1) ?? 1) - 1}`),
    before: 0,
    after: 0,
  });
  let cursor = newest.itemsBefore;
  const read: Item[] = [...newest.items];
  let pages = 0;
  while (cursor !== null && pages++ < 40) {
    const page = await client.itemsWindow({
      threadId: h.thread.id,
      aroundSeq: cursor,
      before: 199,
      after: 0,
      wholeTurns: true,
    });
    const first = page.items[0];
    if (!first) throw new Error("Empty page");
    const older = page.items.slice(0, -1);
    const turns = new Set(older.map(turnOf));
    if (turns.size > 1 || first.id.startsWith("prompt-")) {
      // Every turn in the page is whole from its prompt: the page starts with one.
      expect(first.id).toBe(`prompt-${turnOf(first)}`);
    } else {
      // One turn larger than the page fills it: the budget cuts it and more is older.
      expect(sizes[turnOf(first) - 1]).toBeGreaterThan(199);
      expect(page.itemsBefore).not.toBeNull();
    }
    // The page ends at the item it was read before, so nothing between is skipped.
    expect(page.items.at(-1)?.id).toBe(read[0]?.id);
    read.unshift(...older);
    cursor = page.itemsBefore;
  }
  expect(read).toHaveLength(all);
  const expected: string[] = [];
  for (const [index, size] of sizes.entries()) {
    expected.push(`prompt-${index + 1}`);
    for (let n = 0; n < size; n++) expected.push(`reply-${index + 1}-${n}`);
  }
  expect(read.map((item) => item.id)).toEqual(expected);
});

// Mutation cases: resubscribing without the held cursor after a gap; replacing the store with
// the daemon's newest window; reordering the replayed items behind the history.
test("a reconnect gap resumes from the held sequence without replacing loaded history", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [rootAgent(h.thread.id, h.directory)]);
  h.daemon.store.appendEvents(
    h.thread.id,
    Array.from({ length: 450 }, (_, n) => message(`old-${n}`, n % 10 ? "assistant" : "user")),
  );
  // The client holds more than the daemon's 200-item snapshot, as the iOS client does.
  const { client, faults } = h.make({ limits: { items: 600 } });
  await ready(client);
  const lease = client.thread(h.thread.id);
  const store = lease.store;
  await when(
    store.select(["order"], (reader) => reader.order.length),
    (length) => length === 200,
  );
  await client.loadOlder(h.thread.id, 200);
  const loaded = [...store.order];
  expect(loaded).toHaveLength(400);
  expect(loaded[0]).toBe("old-50");
  const held = store.cursor;
  // One frame of live events is lost on the way: the next one cannot apply.
  let dropped = false;
  faults.incoming = (incoming, text, deliver) => {
    if (!dropped && incoming.type === "events") {
      dropped = true;
      return;
    }
    deliver(text);
  };
  h.daemon.store.appendEvents(h.thread.id, [message("lost", "assistant")]);
  await when(
    store.select(["cursor"], () => dropped),
    (value) => value,
  );
  h.daemon.store.appendEvents(h.thread.id, [message("after-gap", "user")]);
  await when(
    store.select(["order"], (reader) => reader.order.at(-1)),
    (last) => last === "after-gap",
  );
  // It resumed from what it held, and kept the history it had loaded, in creation order.
  const resubscribed = faults.sent
    .map((frame) => ClientMessage.parse(JSON.parse(frame)))
    .filter((sent) => sent.type === "subscribe" && sent.scope.kind === "thread");
  expect(resubscribed.at(-1)).toMatchObject({ afterSeq: held });
  expect(store.order).toEqual([...loaded, "lost", "after-gap"]);
  expect(itemText(store.item("old-50"))).toBe("old-50");
  lease.release();
});
