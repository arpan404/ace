import { expect, test } from "vitest";
import { harness, memory, thread } from "./read-snapshots.fixture.ts";

const row = (id: string, at: number) => ({ ...thread, id, updatedAt: at, activityAt: at });

/** A client whose own thread list holds one page, with older threads left on the daemon. */
async function pagedList() {
  const f = harness(memory().storage);
  const lease = f.client.threads();
  await f.start();
  const wire = await f.subscribed("threads");
  f.elapse(250);
  f.deliver({
    type: "snapshot",
    subscriptionId: wire.subscriptionId,
    seq: 10,
    view: {
      kind: "threads",
      seq: 10,
      threads: { "new-1": row("new-1", 20) },
      window: { before: { at: 20, id: "new-1" }, total: 2, counts: [] },
    },
  });
  await expect.poll(() => lease.store.ids).toEqual(["new-1"]);
  return { f, lease, subscriptionId: wire.subscriptionId };
}

const pageRequests = (f: ReturnType<typeof harness>) =>
  f.sent.filter((message) => message.type === "threads.page");

test("two views asking for the next page at once send one request and both get its page", async () => {
  const { f, lease, subscriptionId } = await pagedList();
  // History and the Threads panel's Settled, each paging the same list.
  const history = f.client.threadsMore();
  const settled = f.client.threadsMore();
  await expect.poll(() => pageRequests(f).length).toBe(1);
  const request = pageRequests(f)[0];
  if (request?.type !== "threads.page") throw new Error("no page request");
  f.deliver({
    type: "threads.patch",
    requestId: request.requestId,
    subscriptionId,
    seq: 11,
    threads: { "old-1": row("old-1", 10) },
    removed: [],
    window: { before: null, total: 2, counts: [] },
  });
  // Neither is refused: a second request for the cursor the first moved past would be.
  await expect(Promise.all([history, settled])).resolves.toEqual([undefined, undefined]);
  expect(pageRequests(f)).toHaveLength(1);
  expect(lease.store.ids).toContain("old-1");
  lease.release();
  await f.client.close();
});

test("the page after the one just read is asked for on its own", async () => {
  const { f, lease, subscriptionId } = await pagedList();
  const first = f.client.threadsMore();
  await expect.poll(() => pageRequests(f).length).toBe(1);
  const request = pageRequests(f)[0];
  if (request?.type !== "threads.page") throw new Error("no page request");
  f.deliver({
    type: "threads.patch",
    requestId: request.requestId,
    subscriptionId,
    seq: 11,
    threads: { "old-1": row("old-1", 10) },
    removed: [],
    window: { before: { at: 10, id: "old-1" }, total: 3, counts: [] },
  });
  await first;
  // A new cursor: a read of its own, not the finished one again.
  void f.client.threadsMore().catch(() => {});
  await expect.poll(() => pageRequests(f).length).toBe(2);
  lease.release();
  await f.client.close();
});
