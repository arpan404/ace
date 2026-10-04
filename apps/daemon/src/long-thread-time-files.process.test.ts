import { expect, test } from "vitest";
import { storeFixture, start, catchUp, tool } from "./long-thread-test-support.ts";

// Mutations: retaining a removed path in temporal candidates, failing to subtract file
// references, or diverging from sequence catch-up for ordered facts.
// Not executed (tests run at merge).
test("sequence and time catch-up omit a file contribution created then deleted after their cutoff", async () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 100);
  const seq = f.store.headSeq();
  const item = tool(
    "deleted-file",
    "succeeded",
    {
      kind: "file.write",
      changes: [{ path: "deleted.ts", kind: "add", newText: "one\ntwo\n" }],
    },
    "first",
  );
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.created", item },
      { type: "item.deleted", itemId: item.id },
    ],
    200,
  );
  for (const restart of [false, true]) {
    if (restart) await f.restart();
    expect(catchUp(f.store, f.thread, { sinceSeq: seq }).digest.files).toEqual([]);
    expect(catchUp(f.store, f.thread, { sinceTime: 100 }).digest.files).toEqual([]);
  }
});

// Mutations: dropping real zero-line file writes when numeric range deltas are zero.
// Not executed (tests run at merge).
test("time catch-up preserves an empty file creation as a real changed path", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 100);
  const seq = f.store.headSeq();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "empty-file",
          "succeeded",
          {
            kind: "file.write",
            changes: [{ path: "empty.ts", kind: "add", newText: "" }],
          },
          "first",
        ),
      },
    ],
    200,
  );
  const expected = [{ path: "empty.ts", added: 0, removed: 0 }];
  expect(catchUp(f.store, f.thread, { sinceSeq: seq }).digest.files).toEqual(expected);
  expect(catchUp(f.store, f.thread, { sinceTime: 100 }).digest.files).toEqual(expected);
});

// Mutations: treating a still-owned path as absent when a replacement decreases all
// numeric deltas to zero or negative. Not executed (tests run at merge).
test("time catch-up preserves a surviving replacement with no remaining changed lines", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 100);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "replaced-file",
          "succeeded",
          {
            kind: "file.write",
            changes: [{ path: "surviving.ts", kind: "add", newText: "before\n" }],
          },
          "first",
        ),
      },
    ],
    120,
  );
  const seq = f.store.headSeq();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.updated",
        item: tool(
          "replaced-file",
          "succeeded",
          {
            kind: "file.write",
            changes: [{ path: "surviving.ts", kind: "add", newText: "" }],
          },
          "first",
        ),
      },
    ],
    200,
  );
  const expected = [{ path: "surviving.ts", added: 0, removed: 0 }];
  expect(catchUp(f.store, f.thread, { sinceSeq: seq }).digest.files).toEqual(expected);
  expect(catchUp(f.store, f.thread, { sinceTime: 150 }).digest.files).toEqual(expected);
});

// Mutations: deriving temporal file presence solely from current state, losing signed
// reference deltas, or interpreting event time as canonical sequence order.
// Not executed (tests run at merge).
test("an empty file contribution after a time cutoff survives a later deletion dated before the cutoff", async () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 100);
  const item = tool(
    "dated-empty-file",
    "succeeded",
    {
      kind: "file.write",
      changes: [{ path: "dated-empty.ts", kind: "add", newText: "" }],
    },
    "first",
  );
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }], 200);
  f.store.appendEvents(f.thread.id, [{ type: "item.deleted", itemId: item.id }], 100);
  const expected = [{ path: "dated-empty.ts", added: 0, removed: 0 }];
  expect(catchUp(f.store, f.thread, { sinceTime: 150 }).digest.files).toEqual(expected);
  await f.restart();
  expect(catchUp(f.store, f.thread, { sinceTime: 150 }).digest.files).toEqual(expected);
});
