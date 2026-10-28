import { expect, test } from "vitest";
import { finished, harness, hostId, memory, view } from "./read-snapshots.fixture.ts";
import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";

const day = 24 * 60 * 60 * 1000;
function disk() {
  const m = memory();
  const storage: ReadSnapshotStorage = {
    ...m.storage,
    delete: async (key) => {
      m.values.delete(key);
    },
    deletePrefix: async (prefix) => {
      for (const key of m.values.keys()) if (key.startsWith(prefix)) m.values.delete(key);
    },
  };
  return { ...m, storage };
}
async function open(storage: ReadSnapshotStorage, now: () => number, seq = 10) {
  const f = harness(storage, 32, { host: hostId, now });
  await f.start();
  const lease = f.client.thread("thread");
  f.deliver({
    type: "snapshot",
    subscriptionId: f.wire("thread").subscriptionId,
    seq,
    view: view("Current", seq),
  });
  await expect.poll(() => lease.store.unconfirmed).toBe(false);
  return { ...f, lease };
}
const input = { threadId: "thread", before: 5, limit: 2 };
async function answer(f: Awaited<ReturnType<typeof open>>, text = "Earlier", seq = 10) {
  const count = f.sent.filter((message) => message.type === "items.page").length;
  const read = f.client.itemsPage(input);
  await expect
    .poll(() => f.sent.filter((message) => message.type === "items.page").length)
    .toBe(count + 1);
  const request = f.sent.findLast((message) => message.type === "items.page");
  if (!request || request.type !== "items.page") throw new Error("No page request");
  f.deliver({
    type: "items.page",
    requestId: request.requestId,
    threadId: "thread",
    seq,
    items: [finished("older", text)],
    itemSeqs: { older: 2 },
    itemsBefore: null,
  });
  return read;
}

test("older pages survive relaunch and are reused only at the confirmed thread revision", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  const page = await answer(f);
  f.lease.release();
  await f.client.close();
  const next = await open(m.storage, () => 2 * day);
  expect(await next.client.itemsPage(input)).toEqual(page);
  expect(next.sent.some((message) => message.type === "items.page")).toBe(false);
  next.lease.release();
  await next.client.close();
  const changed = await open(m.storage, () => 2 * day, 11);
  expect((await answer(changed, "Edited", 11)).items).toEqual([finished("older", "Edited")]);
  changed.lease.release();
  await changed.client.close();
});

test("pages expire after seven days and clearing cached chats forces another daemon read", async () => {
  const m = disk();
  let at = day;
  const f = await open(m.storage, () => at);
  await answer(f);
  at += 7 * day;
  await answer(f, "Refreshed");
  await f.client.clearReadSnapshots();
  expect([...m.values.keys()].some((key) => key.includes("/history/"))).toBe(false);
  await answer(f, "After clear");
  f.lease.release();
  await f.client.close();
});

test("reloading a thread drops its older pages without dropping another thread's records", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  await answer(f);
  m.values.set(`${hostId}/history/other/page`, { unrelated: true });
  await f.client.forgetThread("thread");
  expect(m.values.has(`${hostId}/history/other/page`)).toBe(true);
  await answer(f, "Reloaded");
  f.lease.release();
  await f.client.close();
});

test("a response arriving after a clear cannot put the discarded page back on disk", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  const read = f.client.itemsPage(input);
  await expect.poll(() => f.sent.some((message) => message.type === "items.page")).toBe(true);
  await f.client.clearReadSnapshots();
  const request = f.sent.findLast((message) => message.type === "items.page");
  if (!request || request.type !== "items.page") throw new Error("No request");
  f.deliver({
    type: "items.page",
    requestId: request.requestId,
    threadId: "thread",
    seq: 10,
    items: [finished("older", "In flight")],
    itemSeqs: { older: 2 },
    itemsBefore: null,
  });
  await read;
  expect([...m.values.keys()].some((key) => key.includes("/history/"))).toBe(false);
  f.lease.release();
  await f.client.close();
});

test("opened text survives relaunch while a changed descriptor reads new content", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  const source = { streamId: "text:revision-1", bytes: 12, encoding: "utf-16le" as const };
  const collect = async (owner: typeof f.client, descriptor = source) => {
    let text = "";
    for await (const part of owner.text(descriptor)) text += part;
    return text;
  };
  const read = collect(f.client);
  await expect.poll(() => f.sent.some((message) => message.type === "output.read")).toBe(true);
  const request = f.sent.findLast((message) => message.type === "output.read");
  if (!request || request.type !== "output.read") throw new Error("No output request");
  f.deliver({
    type: "output.data",
    requestId: request.requestId,
    streamId: source.streamId,
    offset: 0,
    bytes: Buffer.from("Old 👋", "utf16le").toString("base64"),
    nextOffset: 12,
    eof: true,
  });
  expect(await read).toBe("Old 👋");
  f.lease.release();
  await f.client.close();
  const next = await open(m.storage, () => 2 * day);
  expect(await collect(next.client)).toBe("Old 👋");
  expect(next.sent.some((message) => message.type === "output.read")).toBe(false);
  const abort = new AbortController();
  const changed = (async () => {
    for await (const _ of next.client.text(
      { ...source, streamId: "text:revision-2" },
      { signal: abort.signal },
    )) {
      /* consume */
    }
  })();
  await expect.poll(() => next.sent.some((message) => message.type === "output.read")).toBe(true);
  abort.abort();
  await expect(changed).rejects.toMatchObject({ code: "aborted" });
  next.lease.release();
  await next.client.close();
});

test("jump windows are kept on disk and an aborted cached read never returns a page", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  const target = { threadId: "thread", itemId: "older", before: 1, after: 1 };
  const read = f.client.itemsWindow(target);
  await expect.poll(() => f.sent.some((message) => message.type === "items.window")).toBe(true);
  const request = f.sent.findLast((message) => message.type === "items.window");
  if (!request || request.type !== "items.window") throw new Error("No window request");
  f.deliver({
    type: "items.window",
    requestId: request.requestId,
    threadId: "thread",
    seq: 10,
    targetSeq: 2,
    items: [finished("older", "Jumped")],
    itemSeqs: { older: 2 },
    itemsBefore: null,
    itemsAfter: 3,
  });
  const page = await read;
  expect(await f.client.itemsWindow(target)).toEqual(page);
  expect(f.sent.filter((message) => message.type === "items.window")).toHaveLength(1);
  const abort = new AbortController();
  abort.abort();
  await expect(f.client.itemsWindow(target, { signal: abort.signal })).rejects.toMatchObject({
    code: "aborted",
  });
  f.lease.release();
  await f.client.close();
});

test("corrupt cached pages fall back to the daemon", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  await answer(f);
  for (const [key, value] of m.values) {
    if (key.includes("/history/"))
      m.values.set(key, { version: 1, saved: day, value: { corrupt: value } });
  }
  expect((await answer(f, "Recovered")).items).toEqual([finished("older", "Recovered")]);
  f.lease.release();
  await f.client.close();
});

test("a released thread cannot validate an old page using its idle in-memory cursor", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  await answer(f);
  f.lease.release();
  expect((await answer(f, "Changed while away", 11)).items).toEqual([
    finished("older", "Changed while away"),
  ]);
  await f.client.close();
});

test("cold text still streams before the full read finishes and cached chunks preserve emoji boundaries", async () => {
  const m = disk();
  const f = await open(m.storage, () => day);
  const expected = "a".repeat(128 * 1024 - 1) + "👋";
  const bytes = Buffer.from(expected, "utf16le");
  const source = {
    streamId: "text:long-revision",
    bytes: bytes.length,
    encoding: "utf-16le" as const,
  };
  const reader = f.client.text(source);
  const first = reader.next();
  await expect
    .poll(() => f.sent.filter((message) => message.type === "output.read").length)
    .toBe(1);
  const respond = (offset: number, end: number) => {
    const request = f.sent.findLast((message) => message.type === "output.read");
    if (!request || request.type !== "output.read") throw new Error("No text request");
    f.deliver({
      type: "output.data",
      requestId: request.requestId,
      streamId: source.streamId,
      offset,
      bytes: bytes.subarray(offset, end).toString("base64"),
      nextOffset: end,
      eof: end === bytes.length,
    });
  };
  respond(0, 256 * 1024);
  expect(await first).toEqual({ done: false, value: "a".repeat(128 * 1024 - 1) });
  const second = reader.next();
  await expect
    .poll(() => f.sent.filter((message) => message.type === "output.read").length)
    .toBe(2);
  respond(256 * 1024, bytes.length);
  expect(await second).toEqual({ done: false, value: "👋" });
  expect((await reader.next()).done).toBe(true);
  const chunks: string[] = [];
  for await (const chunk of f.client.text(source)) chunks.push(chunk);
  expect(chunks).toEqual(["a".repeat(128 * 1024 - 1), "👋"]);
  expect(chunks.join("")).toBe(expected);
  expect(f.sent.filter((message) => message.type === "output.read")).toHaveLength(2);
  f.lease.release();
  await f.client.close();
});
