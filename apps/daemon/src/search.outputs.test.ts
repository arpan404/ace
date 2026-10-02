import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Item } from "@ace/protocol";
import { outputDeltas } from "@ace/projection";
import { fixture } from "./socket-test-support.ts";
import { Store } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

test("shell completion, restart and rebuild preserve output heads and tails with one batch write", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const item = Item.parse({
    id: "searchshell",
    agentId: "root",
    type: "tool_call",
    complete: false,
    createdAt: 1,
    call: {
      id: "searchshell",
      agentId: "root",
      kind: "shell",
      title: "Shell",
      status: "running",
      startedAt: 1,
      raw: [],
      detail: { kind: "shell", command: "echo" },
    },
  });
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
  const writes = f.store.search.status(f.store.headSeq()).indexWrites;
  const text =
    "headneedle " + "x".repeat(90_000) + " middleneedle " + "x".repeat(90_000) + " tailneedle";
  for (const append of outputDeltas(text))
    f.store.appendEvents(f.thread.id, [
      { type: "item.delta", itemId: item.id, agentId: item.agentId, field: "output", append },
    ]);
  expect(f.store.search.status(f.store.headSeq()).indexWrites).toBe(writes);
  const completed = Item.parse({
    ...f.store.snapshotThread(f.thread.id).items[item.id],
    complete: true,
  });
  f.store.appendEvents(f.thread.id, [{ type: "item.updated", item: completed }]);
  expect(f.store.search.status(f.store.headSeq()).indexWrites).toBe(writes + 1);
  const verify = (store: Store) => {
    expect(store.search.query({ text: "headneedle" }).hits[0]?.itemId).toBe(item.id);
    expect(store.search.query({ text: "tailneedle" }).hits[0]?.itemId).toBe(item.id);
    expect(store.search.query({ text: "middleneedle" }).hits).toEqual([]);
  };
  verify(f.store);
  await f.store.close();
  const reopened = new Store(join(f.home, "events.sqlite"));
  try {
    verify(reopened);
    await reopened.search.rebuild(reopened, { signal: new AbortController().signal });
    verify(reopened);
    reopened.deleteThread(f.thread.id);
    expect(reopened.search.query({ text: "headneedle" }).hits).toEqual([]);
    await reopened.search.rebuild(reopened, { signal: new AbortController().signal });
    expect(reopened.search.status(reopened.headSeq()).ready).toBe(true);
    expect(reopened.search.query({ text: "tailneedle" }).hits).toEqual([]);
  } finally {
    await reopened.close();
  }
});
