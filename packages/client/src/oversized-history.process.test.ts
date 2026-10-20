import { afterEach, expect, test } from "vitest";
import { AgentId, ItemId, type EventPayload, type Item, type ThreadId } from "@ace/protocol";
import { setup, ready, when } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const root = AgentId.parse("oversized-root");
const message = (id: string): EventPayload => ({
  type: "item.created",
  item: {
    type: "message",
    id: ItemId.parse(id),
    agentId: root,
    role: "assistant",
    createdAt: 1,
    complete: true,
    synthetic: false,
    raw: [],
    parts: [{ type: "text", text: id }],
  },
});
/** A shell call whose heredoc alone is larger than a whole 1 MiB page, as Codex records them. */
const heredoc = (): EventPayload => {
  const command = `cat > notes.md <<'EOF'\n${"é".repeat(700_000)}\nEOF`;
  return {
    type: "item.created",
    item: {
      type: "tool_call",
      id: ItemId.parse("huge-heredoc"),
      agentId: root,
      createdAt: 1,
      complete: true,
      call: {
        id: ItemId.parse("huge-heredoc"),
        agentId: root,
        kind: "shell",
        title: `Run ${command}`,
        status: "succeeded",
        startedAt: 1,
        detail: { kind: "shell", command },
        raw: [{ type: "commandExecution", data: { command } }],
      },
    },
  };
};
async function seeded() {
  const h = await setup();
  cleanup = h.cleanup;
  const id = h.thread.id;
  h.daemon.store.appendEvents(id, [
    {
      type: "agent.created",
      agent: {
        id: root,
        threadId: id,
        parentId: null,
        origin: "root",
        fidelity: "full",
        native: { provider: "codex" },
        cwd: h.directory,
        status: { state: "idle" },
        createdAt: 1,
        background: false,
      },
    },
  ]);
  const older = Array.from({ length: 10 }, (_, n) => `older-${n}`);
  const newer = Array.from({ length: 250 }, (_, n) => `newer-${n}`);
  h.daemon.store.appendEvents(id, older.map(message));
  h.daemon.store.appendEvents(id, [heredoc()]);
  h.daemon.store.appendEvents(id, newer.map(message));
  return { h, id, expected: [...older, "huge-heredoc", ...newer] };
}
const reducedTitle = (item: Item | undefined) =>
  item?.type === "tool_call" ? item.call.title : undefined;

// Mutation cases: the daemon failing the page at the oversized item; sending it whole; keeping
// the cursor at it so the next read returns the same page.
test("scrolling back past an item larger than a page loads the earlier items", async () => {
  const { h, id, expected } = await seeded();
  const { client } = h.make({ limits: { items: 600 } });
  await ready(client);
  const lease = client.thread(id);
  const store = lease.store;
  await when(
    store.select(["order"], (reader) => reader.order.length),
    (length) => length > 0,
  );
  for (let reads = 0; reads < 20 && store.order[0] !== "older-0"; reads++)
    await client.loadOlder(id, 50);
  expect([...store.order]).toEqual(expected);
  const title = reducedTitle(store.item("huge-heredoc"));
  expect(title).toMatch(/^Run cat > notes\.md/);
  expect(title).toMatch(/more characters not shown\]$/);
});

// Mutation cases: a window that stalls at the oversized item (its cursor never moves), or one
// that fails because the item is the window's target.
test("whole-turn windows read back past an item larger than a window", async () => {
  const { h, id, expected } = await seeded();
  const { client } = h.make();
  await ready(client);
  const newest = await client.itemsWindow({
    threadId: id as ThreadId,
    itemId: ItemId.parse("newer-249"),
    before: 0,
    after: 0,
  });
  const read: Item[] = [...newest.items];
  let cursor = newest.itemsBefore;
  for (let pages = 0; cursor !== null && pages < 20; pages++) {
    const page = await client.itemsWindow({
      threadId: id as ThreadId,
      aroundSeq: cursor,
      before: 199,
      after: 0,
      wholeTurns: true,
    });
    // Each window ends at the item the previous one began with, and moves the cursor back.
    expect(page.items.at(-1)?.id).toBe(read[0]?.id);
    expect(page.itemsBefore === null || page.itemsBefore < cursor).toBe(true);
    read.unshift(...page.items.slice(0, -1));
    cursor = page.itemsBefore;
  }
  expect(cursor).toBeNull();
  expect(read.map((item) => item.id)).toEqual(expected);
  expect(reducedTitle(read.find((item) => item.id === "huge-heredoc"))).toMatch(
    /more characters not shown\]$/,
  );
});
