import type { ContextResult } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { hash, thread, uploads } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  // Chunk durability is not what these tests cover; skipping the fsync keeps 1,000 uploads fast.
  const value = await uploads({}, { syncChunk: async () => {} });
  cleanups.push(() => value.close());
  return value;
}
type Page = Extract<ContextResult["result"], { kind: "attachments" }>;
async function page(
  f: Awaited<ReturnType<typeof fixture>>,
  cursor?: string,
  limit?: number,
): Promise<Page> {
  const result = await f.store.handle("device", {
    op: "attachment.list",
    threadId: thread,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (result.kind !== "attachments") throw new Error("Expected an attachments page");
  return result;
}
const file = (n: number) => Buffer.from(`screenshot ${n}`);

test("a page cursor stays put while files are added and removed between pages", async () => {
  const f = await fixture();
  for (let n = 0; n < 10; n++) await f.put(file(n), thread, `shot-${n}.png`);
  const first = await page(f, undefined, 4);
  expect(first.attachments.map((entry) => entry.name)).toEqual([
    "shot-9.png",
    "shot-8.png",
    "shot-7.png",
    "shot-6.png",
  ]);
  // A new screenshot arrives and one already shown is removed; the next page neither repeats
  // nor skips anything older.
  await f.put(file(10), thread, "shot-10.png");
  await f.store.handle("device", {
    op: "attachment.release",
    threadId: thread,
    sha256: hash(file(8)),
  });
  const second = await page(f, first.nextCursor, 4);
  expect(second.attachments.map((entry) => entry.name)).toEqual([
    "shot-5.png",
    "shot-4.png",
    "shot-3.png",
    "shot-2.png",
  ]);
  // The same cursor asked again gives the same page.
  expect(await page(f, first.nextCursor, 4)).toEqual(second);
  const last = await page(f, second.nextCursor, 4);
  expect(last.attachments.map((entry) => entry.name)).toEqual(["shot-1.png", "shot-0.png"]);
  expect(last.nextCursor).toBeUndefined();
});

test("a cursor the daemon never handed out is refused with a way forward", async () => {
  const f = await fixture();
  await f.put(file(0));
  await expect(page(f, "not-a-cursor")).rejects.toMatchObject({
    code: "invalid_request",
    message: expect.stringContaining("open it again"),
  });
});

test("an empty thread lists no files and no next page", async () => {
  const f = await fixture();
  expect(await page(f)).toEqual({ kind: "attachments", attachments: [] });
});
