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

test("one thread can hold thousands of unfinished attachment reads: there is no lease cap", async () => {
  const f = await fixture();
  const hash = await image(f);
  const held = [];
  for (let i = 0; i < 5000; i++) held.push(await f.store.acquireMessage("device", thread, [hash]));
  const more = await f.store.acquireMessage("device", thread, [hash]);
  expect(more.blobs[0]?.attachment.sha256).toBe(hash);
  more.release();
  for (const lease of held) lease.release();
});

test("a file stays readable while any message still holds it, and releasing twice changes nothing", async () => {
  const f = await fixture();
  const hash = await image(f);
  const first = await f.store.acquireMessage("device", thread, [hash]);
  const second = await f.store.acquireMessage("device", thread, [hash]);
  first.release();
  first.release();
  const again = await f.store.acquireMessage("device", thread, [hash]);
  expect(again.blobs[0]?.attachment.sha256).toBe(hash);
  again.release();
  second.release();
});
