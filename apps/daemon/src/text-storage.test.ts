import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Item } from "@ace/protocol";
import { Store } from "./index.ts";
import { fixture } from "./socket-test-support.ts";
import { message } from "./payload-test-support.ts";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
it.each(["message", "reasoning", "notice"])(
  "persists %s appends without rewriting accumulated text and materializes them after restart",
  async (type) => {
    const f = await fixture();
    cleanups.push(() => f.close());
    const text = "x".repeat(1024 * 1024);
    const item =
      type === "message"
        ? message("large", text)
        : Item.parse({
            id: "large",
            agentId: "root",
            type,
            text,
            level: "info",
            createdAt: 1,
            complete: false,
          });
    f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
    const db = new DatabaseSync(join(f.home, "events.sqlite"));
    cleanups.push(() => db.close());
    // A real SQLite write constraint witnesses an O(history) body rewrite without a timing gate.
    db.exec(
      "CREATE TRIGGER forbid_body_rewrite BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT, 'rewrote accumulated text'); END",
    );
    f.store.appendEvents(f.thread.id, [
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: "é\0" },
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: type === "message" ? "text" : "reasoning",
        append: "!",
      },
    ]);
    const reopened = new Store(join(f.home, "events.sqlite"));
    cleanups.push(() => reopened.close());
    const result = reopened.readItems(f.thread.id, reopened.headSeq() + 1, 1).items[0];
    expect(result).toMatchObject(
      type === "message" ? { parts: [{ text: text + "é\0!" }] } : { text: text + "é\0!" },
    );
  },
);
it("appends after non-text message parts, replaces earlier chunks on authoritative updates and rolls failed appends back", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const item = Item.parse({ ...message("m"), parts: [{ type: "file", path: "/repo/file" }] });
  const delta = (append: string) => ({
    type: "item.delta" as const,
    itemId: item.id,
    agentId: item.agentId,
    field: "text" as const,
    append,
  });
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }, delta(""), delta("first")]);
  expect(f.store.snapshotThread(f.thread.id).items.m).toMatchObject({
    parts: [
      { type: "file", path: "/repo/file" },
      { type: "text", text: "first" },
    ],
  });
  f.store.appendEvents(f.thread.id, [
    { type: "item.updated", item: message("m", "replacement") },
    delta(" last"),
  ]);
  const head = f.store.headSeq();
  expect(() =>
    f.store.appendEvents(f.thread.id, [
      delta(" rolled back"),
      { type: "thread.created", thread: f.thread },
    ]),
  ).toThrow();
  expect(f.store.headSeq()).toBe(head);
  expect(f.store.snapshotThread(f.thread.id).items.m).toMatchObject({
    parts: [{ text: "replacement last" }],
  });
  f.store.deleteThread(f.thread.id);
  const db = new DatabaseSync(join(f.home, "events.sqlite"));
  cleanups.push(() => db.close());
  expect(db.prepare("SELECT count(*) AS n FROM item_text_chunks").get()?.n).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM item_heads").get()?.n).toBe(0);
});
