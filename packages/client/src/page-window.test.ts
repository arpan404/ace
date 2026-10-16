import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { pageWindow } from "./page-window.ts";

const message = (id: string) =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "user",
    createdAt: 0,
    complete: true,
    parts: [{ type: "text", text: id }],
  });

test("loading older history keeps the live tail newest", () => {
  const current = ["newer-a", "newer-b"];
  const creation = new Map([
    ["newer-a", 3],
    ["newer-b", 4],
  ]);
  const page = {
    seq: 10,
    threadId: "thread",
    items: [message("older-a"), message("older-b")],
    itemSeqs: { "older-a": 1, "older-b": 2 },
    itemsBefore: null,
  };
  const window = pageWindow(current, creation, page, 2);
  expect(window.order).toEqual(["older-a", "older-b", "newer-a", "newer-b"]);
  expect(window.before).toBeNull();
});

test("loading older at capacity still shows both ends", () => {
  const current = ["b", "c"];
  const creation = new Map([
    ["b", 2],
    ["c", 3],
  ]);
  const page = {
    seq: 10,
    threadId: "thread",
    items: [message("a")],
    itemSeqs: { a: 1 },
    itemsBefore: null,
  };
  const window = pageWindow(current, creation, page, 2);
  expect(window.order).toEqual(["a", "b", "c"]);
});
