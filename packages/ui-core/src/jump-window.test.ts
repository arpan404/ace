import { Item, ThreadId, type ItemsWindowResponse } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  meetsTail,
  newerRequest,
  olderRequest,
  openWindow,
  windowCapacity,
  withNewer,
  withOlder,
} from "./jump-window.ts";

/*
 * A thread of 1,000 items whose creation sequences are 10, 20, 30, ... (host-wide sequences
 * leave gaps). `reply` answers `items.window` the way the daemon does.
 */
const total = 1_000;
const seqOf = (n: number) => n * 10;
const item = (n: number): Item =>
  Item.parse({
    id: `item-${n}`,
    agentId: "root",
    type: "notice",
    level: "info",
    text: `notice ${n}`,
    raw: [],
    createdAt: n,
    complete: true,
  });
function reply(aroundSeq: number, before: number, after: number): ItemsWindowResponse {
  const target = Math.min(total, Math.max(1, Math.ceil(aroundSeq / 10)));
  const from = Math.max(1, target - before);
  const to = Math.min(total, target + after);
  const items: Item[] = [];
  const itemSeqs: Record<string, number> = {};
  for (let n = from; n <= to; n++) {
    items.push(item(n));
    itemSeqs[`item-${n}`] = seqOf(n);
  }
  return {
    type: "items.window",
    requestId: "r",
    threadId: ThreadId.parse("t"),
    seq: seqOf(total),
    targetSeq: seqOf(target),
    items,
    itemSeqs,
    itemsBefore: from > 1 ? seqOf(from) : null,
    itemsAfter: to < total ? seqOf(to) : null,
  };
}
const ids = (window: { items: readonly Item[] }) => window.items.map((entry) => entry.id);
const numbers = (window: { items: readonly Item[] }) =>
  window.items.map((entry) => Number(entry.id.slice(5)));
const contiguous = (window: { items: readonly Item[] }) =>
  numbers(window).every((n, index, all) => index === 0 || n === (all[index - 1] ?? 0) + 1);

test("a jump aims at the reply's target item", () => {
  const window = openWindow(reply(seqOf(500), 20, 179));
  expect(window.targetId).toBe("item-500");
  expect(ids(window)[0]).toBe("item-480");
  expect(window.items).toHaveLength(200);
});

test("sliding newer keeps the window contiguous and at most 200 items", () => {
  let window = openWindow(reply(seqOf(500), 20, 179));
  for (let step = 0; step < 3; step++) {
    const request = newerRequest(window);
    if (!request) throw new Error("expected newer items");
    window = withNewer(window, reply(request.aroundSeq, request.before, request.after));
    expect(window.items.length).toBeLessThanOrEqual(windowCapacity);
    expect(contiguous(window)).toBe(true);
  }
  expect(numbers(window).at(-1)).toBe(979);
  // Items left from the older end, so there are older items to come back to.
  expect(window.before).toBe(seqOf(numbers(window)[0] ?? 0));
  expect(window.targetId).toBe("item-500");
});

test("sliding older stops at the thread's start and then has no older cursor", () => {
  let window = openWindow(reply(seqOf(150), 20, 179));
  for (let step = 0; step < 5 && window.before !== null; step++) {
    const request = olderRequest(window);
    if (!request) break;
    window = withOlder(window, reply(request.aroundSeq, request.before, request.after));
    expect(contiguous(window)).toBe(true);
  }
  expect(numbers(window)[0]).toBe(1);
  expect(window.before).toBeNull();
  expect(olderRequest(window)).toBeUndefined();
  // Newer items were trimmed to stay bounded, so the newer end can be paged again.
  expect(window.after).not.toBeNull();
  expect(window.items.length).toBeLessThanOrEqual(windowCapacity);
});

test("a window reaches the live tail when it shares an item with it", () => {
  const tail = {
    order: Array.from({ length: 200 }, (_, n) => `item-${801 + n}`),
    before: seqOf(801),
  };
  let window = openWindow(reply(seqOf(500), 20, 179));
  expect(meetsTail(window, tail)).toBe(false);
  let steps = 0;
  while (!meetsTail(window, tail)) {
    const request = newerRequest(window);
    if (!request) break;
    window = withNewer(window, reply(request.aroundSeq, request.before, request.after));
    steps++;
  }
  expect(steps).toBe(2);
  expect(ids(window)).toContain("item-801");
});

test("a window that ends where the thread ends has reached the tail", () => {
  const window = openWindow(reply(seqOf(990), 50, 50));
  expect(window.after).toBeNull();
  expect(newerRequest(window)).toBeUndefined();
  expect(meetsTail(window, { order: [], before: seqOf(999) })).toBe(true);
});

test("a tail holding the whole thread always meets a window", () => {
  const window = openWindow(reply(seqOf(10), 5, 5));
  expect(meetsTail(window, { order: ["item-900"], before: null })).toBe(true);
});
