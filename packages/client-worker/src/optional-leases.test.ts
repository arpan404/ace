import { afterEach, expect, test, vi } from "vitest";
import { cleanups, world } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A worker whose client holds three threads, one kept for what the person opens. */
async function small() {
  const setup = world(undefined, {}, undefined, undefined, { threads: 3, threadReserve: 1 });
  for (const id of ["t-a", "t-b", "t-c", "t-d", "t-e"])
    setup.daemon.createThread({ id, workspaceId: "acme", title: id, provider: "codex" });
  const client = setup.tab();
  await client.start();
  const room = client.threadRoom();
  await vi.waitFor(() => expect(room.getSnapshot()).toBe(2));
  return { client, room };
}

test("through the worker, an optional lease takes spare room and is refused once there is none", async () => {
  const { client, room } = await small();
  const a = client.thread("t-a", { optional: true });
  const b = client.thread("t-b", { optional: true });
  await vi.waitFor(() => expect(room.getSnapshot()).toBe(0));
  const c = client.thread("t-c", { optional: true });
  await vi.waitFor(() => expect(c.store.error?.code).toBe("no_room"));
  expect(a.store.error).toBeUndefined();
  // Room frees when one goes, and the tab hears it.
  b.release();
  await vi.waitFor(() => expect(room.getSnapshot()).toBe(1));
  a.release();
  c.release();
});

test("through the worker, threads the person opens take the room of optional ones, never of each other", async () => {
  const { client } = await small();
  const a = client.thread("t-a", { optional: true });
  const b = client.thread("t-b", { optional: true });
  // The person opens one of them too: from then on it is held for them.
  const opened = client.thread("t-a");
  const d = client.thread("t-d");
  const e = client.thread("t-e");
  await vi.waitFor(() => expect(b.store.error?.code).toBe("no_room"));
  for (const lease of [opened, d, e]) expect(lease.store.error).toBeUndefined();
  expect(a.store.error).toBeUndefined();
});
