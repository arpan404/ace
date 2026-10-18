import { Item, Thread, type ThreadView } from "@ace/protocol";
import { createThreadView } from "@ace/projection";
import { expect, test } from "vitest";
import { defaultLimits, ThreadStore } from "./index.ts";

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Resume",
  rootAgentId: "root",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const message = (n: number, complete = true) =>
  Item.parse({
    id: `m-${n}`,
    agentId: "root",
    type: "message",
    role: "assistant",
    createdAt: 0,
    complete,
    parts: [{ type: "text", text: `m-${n}` }],
  });
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, n) => from + n);
/** The daemon's snapshot at `seq`: items with the given sequences, complete from `before`. */
function snapshot(seq: number, seqs: number[], before: number | null, open?: number): ThreadView {
  const view = createThreadView(thread, seq);
  const items = seqs.map((n) => message(n, n !== open));
  view.items = Object.fromEntries(items.map((item) => [item.id, item]));
  view.itemOrder = items.map((item) => item.id);
  view.itemSeqs = Object.fromEntries(seqs.map((n) => [`m-${n}`, n]));
  view.itemsBefore = before;
  return view;
}
/** A store holding items 1..300 whole: a 200-item snapshot and the page before it. */
function holding(open?: number): ThreadStore {
  const store = new ThreadStore({ ...defaultLimits, items: 600 });
  store.snapshot(snapshot(300, range(101, 300), 101, open));
  const older = range(1, 100).map((n) => message(n, n !== open));
  store.page(
    {
      seq: 300,
      threadId: thread.id,
      items: older,
      itemSeqs: Object.fromEntries(range(1, 100).map((n) => [`m-${n}`, n])),
      itemsBefore: null,
    },
    101,
  );
  return store;
}
const ids = (numbers: number[]) => numbers.map((n) => `m-${n}`);

test("a resnapshot that meets the held history keeps it and takes its own range as given", () => {
  const store = holding();
  // Item 250 was deleted while the client was away; 301..350 are new.
  const fresh = range(201, 350).filter((n) => n !== 250);
  store.snapshot(snapshot(400, fresh, 201));
  expect(store.order).toEqual(ids([...range(1, 200), ...fresh]));
  expect(store.itemsBefore).toBeNull();
  expect(store.item("m-250")).toBeUndefined();
  expect(store.itemSeq("m-1")).toBe(1);
});

test("a resnapshot keeps only the finished history after an older item still running", () => {
  // Item 150 was still streaming: the events the gap skipped may have changed it.
  const store = holding(150);
  store.snapshot(snapshot(400, range(201, 350), 201));
  expect(store.order).toEqual(ids([...range(151, 200), ...range(201, 350)]));
  expect(store.itemsBefore).toBe(151);
});

test("a resnapshot past a gap in the held history replaces it", () => {
  const store = holding();
  store.snapshot(snapshot(900, range(701, 900), 701));
  expect(store.order).toEqual(ids(range(701, 900)));
  expect(store.itemsBefore).toBe(701);
});
