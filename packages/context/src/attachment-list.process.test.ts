import type { Attachment, ContextResult } from "@ace/protocol";
import { afterAll, beforeAll, expect, test } from "vitest";
import { attachment, thread, uploads } from "./test-support.ts";

// A long thread full of screenshots, through real uploads into real SQLite and blob files. Each
// upload costs a few milliseconds of disk work, which is why 1,000 of them live in the process
// tier; paging rules on small threads are in attachment-list.test.ts.

let f: Awaited<ReturnType<typeof uploads>>;
const added: string[] = [];
beforeAll(async () => {
  f = await uploads({}, { syncChunk: async () => {} });
  for (let n = 0; n < 1000; n++)
    added.push(
      attachment(await f.put(Buffer.from(`screenshot ${n}`), thread, `shot-${n}.png`)).sha256,
    );
}, 30_000);
afterAll(() => f.close());

type Page = Extract<ContextResult["result"], { kind: "attachments" }>;
async function page(cursor?: string): Promise<Page> {
  const result = await f.store.handle("device", {
    op: "attachment.list",
    threadId: thread,
    ...(cursor === undefined ? {} : { cursor }),
  });
  if (result.kind !== "attachments") throw new Error("Expected an attachments page");
  return result;
}

test("a thread accepts 1,000 attachments and lists every one, newest first, across pages", async () => {
  const listed: Attachment[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const next = await page(cursor);
    expect(next.attachments.length).toBeLessThanOrEqual(256);
    listed.push(...next.attachments);
    cursor = next.nextCursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(4);
  expect(listed.map((entry) => entry.sha256)).toEqual(added.toReversed());
  expect(listed[0]?.name).toBe("shot-999.png");
});

test("a client that never pages still gets the newest files in one bounded answer", async () => {
  // The request an older client sends: no cursor, no limit.
  const result = await f.store.handle("device", { op: "attachment.list", threadId: thread });
  if (result.kind !== "attachments") throw new Error("Expected an attachments page");
  expect(result.attachments).toHaveLength(256);
  expect(result.attachments[0]?.name).toBe("shot-999.png");
  expect(result.attachments.at(-1)?.name).toBe("shot-744.png");
});
