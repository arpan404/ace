import { Item, ItemsWindowResponse } from "@ace/protocol";
import { expect, test } from "vitest";
import { JumpController } from "./jump-controller.ts";

/* An opened history window corrected in place (ADR 0149). Item n has creation sequence 10n. */

const notice = (n: number, text = `notice ${n}`): Item =>
  Item.parse({
    id: `item-${n}`,
    agentId: "root",
    type: "notice",
    level: "info",
    text,
    raw: [],
    createdAt: n,
    complete: true,
  });
const numbers = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A window of items 100..150 around item 120, far from the live tail. */
async function opened() {
  const items = numbers(100, 150).map((n) => notice(n));
  const reply = ItemsWindowResponse.parse({
    type: "items.window",
    requestId: "r",
    threadId: "t",
    seq: 10_000,
    targetSeq: 1200,
    items,
    itemSeqs: Object.fromEntries(items.map((item, at) => [item.id, (100 + at) * 10])),
    itemsBefore: 1000,
    itemsAfter: 1500,
  });
  const jump = new JumpController(
    { itemsWindow: async () => reply, turnsPage: () => Promise.reject(new Error("no turns")) },
    "t",
  );
  await jump.toItem("item-120");
  return jump;
}

test("a corrected window shows its rows as now read, keeping its range and the reader's place", async () => {
  const jump = await opened();
  const kept = numbers(100, 150).filter((n) => n !== 130);
  jump.revise(
    kept.map((n) => notice(n, n === 110 ? "corrected" : `notice ${n}`)),
    new Map(kept.map((n) => [`item-${n}`, n * 10])),
  );
  const window = jump.snapshot().window;
  expect(window?.items.map((item) => item.id)).toEqual(kept.map((n) => `item-${n}`));
  expect(window?.items[10]).toMatchObject({ text: "corrected" });
  expect(window).toMatchObject({ before: 1000, after: 1500, targetId: "item-120" });
});

test("a correction that removes the item the reader jumped to lands them on the window's first row", async () => {
  const jump = await opened();
  const kept = numbers(100, 150).filter((n) => n !== 120);
  jump.revise(
    kept.map((n) => notice(n)),
    new Map(kept.map((n) => [`item-${n}`, n * 10])),
  );
  expect(jump.snapshot().window?.targetId).toBe("item-100");
});
