import { afterEach, expect, test } from "vitest";
import { uploads, attachment, thread, otherThread } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(...args: Parameters<typeof uploads>) {
  const value = await uploads(...args);
  cleanups.push(() => value.close());
  return value;
}
async function image(f: Awaited<ReturnType<typeof fixture>>, target = thread) {
  return attachment(await f.put(Buffer.from(`screenshot for ${target}`), target)).sha256;
}

test("a thread holding 200 unfinished attachment reads doesn't block uploads or reads anywhere", async () => {
  const f = await fixture();
  const busy = await image(f);
  const quiet = await image(f, otherThread);
  // A long turn that took 200 screenshots: each message's files stay leased until it ends.
  const held = [];
  for (let i = 0; i < 200; i++) held.push(await f.store.acquireMessage("device", thread, [busy]));
  expect(attachment(await f.put(Buffer.from("one more"))).sha256).toHaveLength(64);
  const read = await f.store.acquire("device", thread, [busy]);
  read.release();
  const other = await f.store.acquireMessage("device", otherThread, [quiet]);
  expect(other.blobs).toHaveLength(1);
  other.release();
  for (const lease of held) lease.release();
});

test("a full thread says what to do instead of naming a lease limit, and heals once leases go stale", async () => {
  const f = await fixture({ threadLeases: 3 });
  const hash = await image(f);
  for (let i = 0; i < 3; i++) await f.store.acquireMessage("device", thread, [hash]);
  const refusal = f.store.acquireMessage("device", thread, [hash]);
  await expect(refusal).rejects.toMatchObject({ code: "busy" });
  await expect(refusal).rejects.toThrow(/Wait for the current turn to finish, or stop it/);
  // Nothing releases the three: their holder is gone. An hour later they are reclaimed.
  f.advance(60 * 60 * 1000 + 1);
  const healed = await f.store.acquireMessage("device", thread, [hash]);
  expect(healed.blobs[0]?.attachment.sha256).toBe(hash);
});

test("a recent lease is never reclaimed to make room", async () => {
  const f = await fixture({ threadLeases: 2 });
  const hash = await image(f);
  await f.store.acquireMessage("device", thread, [hash]);
  f.advance(60 * 60 * 1000 + 1);
  await f.store.acquireMessage("device", thread, [hash]);
  // The stale first lease makes room; the fresh second one holds.
  await f.store.acquireMessage("device", thread, [hash]);
  await expect(f.store.acquireMessage("device", thread, [hash])).rejects.toMatchObject({
    code: "busy",
  });
});

test("leases a deleted thread left behind are reclaimed when other threads need room", async () => {
  const live = new Set<string>([thread, otherThread]);
  const f = await fixture({ leases: 4 }, { threadExists: (id) => live.has(id) });
  const gone = await image(f);
  const kept = await image(f, otherThread);
  for (let i = 0; i < 4; i++) await f.store.acquireMessage("device", thread, [gone]);
  await expect(f.store.acquireMessage("device", otherThread, [kept])).rejects.toThrow(
    /across your threads/,
  );
  live.delete(thread);
  const lease = await f.store.acquireMessage("device", otherThread, [kept]);
  expect(lease.blobs).toHaveLength(1);
});

test("releasing a reclaimed lease again leaves the other holders' counts intact", async () => {
  const f = await fixture({ threadLeases: 2 });
  const hash = await image(f);
  const stale = await f.store.acquireMessage("device", thread, [hash]);
  f.advance(60 * 60 * 1000 + 1);
  await f.store.acquireMessage("device", thread, [hash]);
  await f.store.acquireMessage("device", thread, [hash]);
  // The engine's own late release of the reclaimed lease is a no-op, not a second release.
  stale.release();
  await expect(f.store.acquireMessage("device", thread, [hash])).rejects.toMatchObject({
    code: "busy",
  });
});
