import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyDelivery } from "@ace/projection";
import { AgentItem } from "@ace/protocol";
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
        : AgentItem.parse({
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
  const item = AgentItem.parse({ ...message("m"), parts: [{ type: "file", path: "/repo/file" }] });
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
it.each(["message", "reasoning", "notice"])(
  "preserves split UTF-16 %s text across live delivery, snapshot, paging and reopen",
  async (type) => {
    const f = await fixture();
    cleanups.push(() => f.close());
    const item =
      type === "message"
        ? message("split", "")
        : AgentItem.parse({
            id: "split",
            agentId: "root",
            type,
            level: "info",
            text: "",
            createdAt: 1,
            complete: false,
          });
    f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
    const c = await f.connect();
    await c.next();
    c.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    const initial = await c.next();
    if (initial.type !== "snapshot" || initial.view.kind !== "thread")
      throw new Error("Expected snapshot");
    const live = initial.view;
    for (const append of ["\ud83d", "\ude00", "\ud83d", "x", "\0"]) {
      f.store.appendEvents(f.thread.id, [
        {
          type: "item.delta",
          itemId: item.id,
          agentId: item.agentId,
          field: type === "message" ? "text" : "reasoning",
          append,
        },
      ]);
      const delivery = await c.next();
      if (delivery.type !== "events") throw new Error("Expected events");
      applyDelivery(live, delivery);
      expect(f.store.snapshotThread(f.thread.id).items.split).toEqual(live.items.split);
      expect(f.store.readItems(f.thread.id, f.store.headSeq() + 1, 1).items[0]).toEqual(
        live.items.split,
      );
    }
    const reopened = new Store(join(f.home, "events.sqlite"));
    cleanups.push(() => reopened.close());
    expect(reopened.snapshotThread(f.thread.id).items.split).toEqual(live.items.split);
    expect(reopened.readItems(f.thread.id, reopened.headSeq() + 1, 1).items[0]).toMatchObject(
      type === "message" ? { parts: [{ text: "😀\ud83dx\0" }] } : { text: "😀\ud83dx\0" },
    );
  },
);
it("keeps oversized text outside the snapshot window after an incompatible output delta", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const item = message("large", "");
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item },
    {
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field: "text",
      append: "x".repeat(2 * 1024 * 1024),
    },
  ]);
  expect(f.store.snapshotThread(f.thread.id).itemOrder).toEqual([]);
  f.store.appendEvents(f.thread.id, [
    {
      type: "item.delta",
      itemId: item.id,
      agentId: item.agentId,
      field: "output",
      append: "ignored",
    },
  ]);
  const snapshot = f.store.snapshotThread(f.thread.id);
  expect(snapshot.itemOrder).toEqual([]);
  expect(f.store.readItems(f.thread.id, f.store.headSeq() + 1, 1).items[0]).toMatchObject({
    parts: [{ text: "x".repeat(2 * 1024 * 1024) }],
  });
  const reopened = new Store(join(f.home, "events.sqlite"));
  cleanups.push(() => reopened.close());
  expect(reopened.snapshotThread(f.thread.id).itemOrder).toEqual([]);
});
it("recovers version-four split text chunks from the lossless event log during upgrade", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const item = message("split", "");
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item },
    ...["\ud83d", "\ude00"].map((append) => ({
      type: "item.delta" as const,
      itemId: item.id,
      agentId: item.agentId,
      field: "text" as const,
      append,
    })),
  ]);
  const path = join(f.home, "events.sqlite");
  const db = new DatabaseSync(path);
  cleanups.push(() => db.close());
  // Reproduce schema-four TEXT bindings, including their irreversible UTF-8 replacement.
  const rows = db.prepare("SELECT seq FROM item_text_chunks ORDER BY seq").all();
  const units = ["\ud83d", "\ude00"];
  for (const [index, row] of rows.entries())
    db.prepare("UPDATE item_text_chunks SET append = ? WHERE seq = ?").run(
      units[index] ?? "",
      row.seq ?? 0,
    );
  if (
    db
      .prepare("PRAGMA table_info(item_heads)")
      .all()
      .some((row) => row.name === "text_last_unit")
  )
    db.exec("ALTER TABLE item_heads DROP COLUMN text_last_unit");
  db.exec("DROP TABLE IF EXISTS text_encoding_migration; UPDATE schema_version SET version = 4");
  const reopened = new Store(path);
  cleanups.push(() => reopened.close());
  expect(reopened.snapshotThread(f.thread.id).items.split).toMatchObject({
    parts: [{ text: "😀" }],
  });
});
it("budgets a surrogate pair completed across the authoritative body and an append", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const empty = message("m", "");
  const overhead =
    Buffer.byteLength(JSON.stringify({ m: empty })) + Buffer.byteLength(JSON.stringify(["m"]));
  const item = message("m", "x".repeat(1024 * 1024 - overhead - 5) + "\ud83d");
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
  expect(f.store.snapshotThread(f.thread.id).itemOrder).toEqual([]);
  f.store.appendEvents(f.thread.id, [
    { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "text", append: "\ude00" },
  ]);
  const view = f.store.snapshotThread(f.thread.id);
  expect(view.itemOrder).toEqual(["m"]);
  expect(view.items.m).toMatchObject({
    parts: [{ text: "x".repeat(1024 * 1024 - overhead - 5) + "😀" }],
  });
  expect(
    Buffer.byteLength(JSON.stringify(view.items)) +
      Buffer.byteLength(JSON.stringify(view.itemOrder)),
  ).toBeLessThanOrEqual(1024 * 1024);
});
it("budgets a near-limit surrogate pair split across two appended chunks and retains it after reopen", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const empty = message("m", "");
  const overhead =
    Buffer.byteLength(JSON.stringify({ m: empty })) + Buffer.byteLength(JSON.stringify(["m"]));
  const text = "x".repeat(1024 * 1024 - overhead - 5);
  const item = message("m", text);
  const append = (value: string) =>
    f.store.appendEvents(f.thread.id, [
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "text",
        append: value,
      },
    ]);
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
  append("\ud83d");
  expect(f.store.snapshotThread(f.thread.id).itemOrder).toEqual([]);
  append("\ude00");
  const view = f.store.snapshotThread(f.thread.id);
  expect(view.itemOrder).toEqual(["m"]);
  expect(view.items.m).toMatchObject({ parts: [{ text: text + "😀" }] });
  expect(
    Buffer.byteLength(JSON.stringify(view.items)) +
      Buffer.byteLength(JSON.stringify(view.itemOrder)),
  ).toBe(1_048_575);
  const reopened = new Store(join(f.home, "events.sqlite"));
  cleanups.push(() => reopened.close());
  expect(reopened.snapshotThread(f.thread.id)).toEqual(view);
  expect(reopened.readItems(f.thread.id, reopened.headSeq() + 1, 1).items[0]).toEqual(view.items.m);
});
