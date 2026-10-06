import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ActivityReads } from "./activity-reads.ts";
import { fixture } from "./socket-test-support.ts";
import { Store } from "./store.ts";

// The Activity read cursor through the public socket: persisted per host, merged per change,
// and pushed to every connected device.
test("read marks survive a reconnect and a daemon restart, and start from the first read", async () => {
  const home = mkdtempSync(join(tmpdir(), "ace-activity-reads-"));
  const path = join(home, "reads.sqlite");
  const store = new Store(path);
  const f = await fixture({ activityReads: new ActivityReads(store, () => 5_000) });
  try {
    const client = await f.connect();
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.send({ type: "activity.reads", requestId: "first" });
    expect(await client.next()).toMatchObject({
      type: "activity.reads.result",
      requestId: "first",
      cursor: { before: 5_000, read: [], unread: [] },
    });
    client.send({
      type: "activity.markRead",
      requestId: "mark",
      read: [{ id: "ci:thread:sha", at: 9_000 }],
      unread: [{ id: "run-old", at: 1_000 }],
    });
    // The writer hears the change like everyone else, and gets its reply.
    const replies = [await client.next(), await client.next()];
    expect(replies.map((reply) => reply.type).toSorted()).toEqual([
      "activity.reads.changed",
      "activity.reads.result",
    ]);
    await client.close();

    const again = await f.connect();
    await again.next();
    again.send({ type: "activity.reads", requestId: "again" });
    expect(await again.next()).toMatchObject({
      cursor: {
        before: 5_000,
        read: [{ id: "ci:thread:sha", at: 9_000 }],
        unread: [{ id: "run-old", at: 1_000 }],
      },
    });
  } finally {
    await f.close();
    await store.close();
  }
  const reopened = new Store(path);
  try {
    expect(new ActivityReads(reopened, () => 99_000).get()).toMatchObject({
      before: 5_000,
      read: [{ id: "ci:thread:sha" }],
    });
  } finally {
    await reopened.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Mark all read on one device reaches another device at once", async () => {
  const store = new Store(":memory:");
  const f = await fixture({ activityReads: new ActivityReads(store, () => 1_000) });
  try {
    const laptop = await f.connect();
    const phone = await f.connect();
    await laptop.next();
    await phone.next();
    laptop.send({ type: "activity.markRead", requestId: "all", allBefore: 50_000 });
    const pushed = await phone.next();
    expect(pushed).toMatchObject({
      type: "activity.reads.changed",
      cursor: { before: 50_000, read: [], unread: [] },
    });
  } finally {
    await f.close();
    await store.close();
  }
});

test("an unauthenticated socket can't read or change Activity read state", async () => {
  const store = new Store(":memory:");
  const f = await fixture({ activityReads: new ActivityReads(store, () => 1_000) });
  try {
    const client = await f.open();
    client.send({ type: "activity.markRead", requestId: "sneak", allBefore: 9_000 });
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
  } finally {
    await f.close();
    await store.close();
  }
});
