import { expect, test } from "vitest";
import { agentMessage, root, storeFixture, tool, window } from "./long-thread-test-support.ts";

// Mutations: ignoring the byte allowance, skipping a rejected neighbor, dropping
// the jump target, or returning a partial oversized tool body.
// Not executed (tests run at merge).
test("windows and pages stop at oversized tool details without skipping the blocked interval", () => {
  const f = storeFixture();
  // UTF-8 and JSON escapes both matter: character count is not the wire byte count.
  const command = "é\u0000\ud800".repeat(100_000);
  const events = f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.created", item: agentMessage("older") },
      { type: "item.created", item: tool("oversized", "succeeded", { kind: "shell", command }) },
      { type: "item.created", item: agentMessage("target") },
      { type: "item.created", item: agentMessage("newer") },
    ],
    20,
  );
  const oversized = events.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "oversized",
  );
  const target = events.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "target",
  );
  if (!oversized || !target) throw new Error("Missing item events");
  const jumped = window(f.store, f.thread, { aroundSeq: target.seq }, 2, 1);
  expect(jumped.items.map((item) => item.id)).toEqual(["target"]);
  expect(jumped.targetSeq).toBe(target.seq);
  expect(jumped.itemsBefore).toBe(target.seq);
  expect(jumped.itemsAfter).toBe(target.seq);
  const tail = f.store.readItemPage(f.thread.id, f.store.headSeq() + 1, 200);
  expect(tail.items.map((item) => item.id)).toEqual(["target", "newer"]);
  expect(tail.itemsBefore).toBe(target.seq);
  expect(() => window(f.store, f.thread, { aroundSeq: oversized.seq })).toThrow(
    "Item detail exceeds page capacity",
  );
  expect(() => f.store.readItemPage(f.thread.id, target.seq, 1)).toThrow(
    "Item detail exceeds page capacity",
  );
});

// Mutation: granting each neighbor a fresh page allowance instead of the remaining
// window allowance. Not executed (tests run at merge).
test("individually readable tool bodies cannot exceed a window's combined byte budget", () => {
  const f = storeFixture();
  const records = f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool("neighbor", "succeeded", { kind: "shell", command: "x".repeat(600 * 1024) }),
      },
      {
        type: "item.created",
        item: tool("target", "succeeded", { kind: "shell", command: "x".repeat(600 * 1024) }),
      },
    ],
    20,
  );
  const neighbor = records.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "neighbor",
  );
  const target = records.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === "target",
  );
  if (!neighbor || !target) throw new Error("Missing tool events");
  for (const created of [neighbor, target])
    expect(f.store.readItemPage(f.thread.id, created.seq + 1, 1).items).toHaveLength(1);
  const jumped = window(f.store, f.thread, { aroundSeq: target.seq }, 1, 0);
  expect(jumped.items.map((item) => item.id)).toEqual(["target"]);
  expect(jumped.itemsBefore).toBe(target.seq);
  expect(jumped.itemsAfter).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(jumped))).toBeLessThanOrEqual(1024 * 1024);
});

// Mutations: rejecting full text size instead of its bounded preview, counting
// characters rather than encoded wire bytes, dropping source descriptors, or
// losing a surrogate pair spanning appended chunks. Not executed (tests run at merge).
test("large Unicode message previews retain contiguous windows and their complete text source", async () => {
  const f = storeFixture();
  const target = agentMessage("unicode", "😀é\u0000".repeat(200_000));
  const initial = f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.created", item: agentMessage("before") },
      { type: "item.created", item: target },
      { type: "item.created", item: agentMessage("after") },
    ],
    20,
  );
  const created = initial.find(
    (event) => event.payload.type === "item.created" && event.payload.item.id === target.id,
  );
  if (!created) throw new Error("Missing target");
  for (const append of ["\ud83d", "\ude00 trailing"]) {
    f.store.appendEvents(
      f.thread.id,
      [{ type: "item.delta", itemId: target.id, agentId: root, field: "text", append }],
      30,
    );
  }
  await f.restart();
  const page = f.store.readItemPage(f.thread.id, f.store.headSeq() + 1, 200);
  const jumped = window(f.store, f.thread, { aroundSeq: created.seq }, 1, 1);
  for (const response of [page, jumped]) {
    expect(response.items.map((item) => item.id)).toEqual(["before", "unicode", "after"]);
    expect(response.itemsBefore).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(1024 * 1024);
  }
  expect(jumped.itemsAfter).toBeNull();
  const preview = jumped.items[1];
  if (preview?.type !== "message" || preview.parts[0]?.type !== "text")
    throw new Error("Missing message preview");
  const part = preview.parts[0];
  expect(part.text).toBe("😀é\u0000".repeat(1024));
  if (!part.source) throw new Error("Missing full text source");
  const expected = "😀é\u0000".repeat(200_000) + "😀 trailing";
  expect(part.source.bytes).toBe(expected.length * 2);
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < part.source.bytes) {
    const chunk = f.store.readOutput(part.source.streamId, offset, 256 * 1024);
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    chunks.push(Buffer.from(chunk.bytes, "base64"));
    offset = chunk.nextOffset;
  }
  expect(Buffer.concat(chunks).toString("utf16le")).toBe(expected);
});
