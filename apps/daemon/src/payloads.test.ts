import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  AgentId,
  BackgroundTask,
  Interaction,
  Item,
  ThreadId,
  type EventPayload,
} from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";
import { Store } from "./store.ts";
import { message, shell } from "./payload-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}
const delta = (append: string): Extract<EventPayload, { type: "item.delta" }> => ({
  type: "item.delta",
  itemId: shell().id,
  agentId: AgentId.parse("root"),
  field: "output",
  append,
});

it("reads exact byte ranges across persisted output chunks over authenticated sockets and reopen", async () => {
  const f = await setup();
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item: shell() },
    delta("abc😀"),
    delta("def"),
  ]);
  const c = await f.connect();
  await c.next();
  c.send({ type: "output.read", requestId: "r", streamId: "output:shell", offset: 4, limit: 4 });
  const data = await c.next();
  expect(data).toMatchObject({ type: "output.data", nextOffset: 8, eof: false });
  if (data.type !== "output.data") throw new Error("Expected output");
  expect(Buffer.from(data.bytes, "base64")).toEqual(Buffer.from("abc😀def").subarray(4, 8));
  const reopened = new Store(join(f.home, "events.sqlite"));
  cleanups.push(() => reopened.close());
  expect(
    Buffer.from(reopened.readOutput("output:shell", 0, 256 * 1024).bytes, "base64").toString(),
  ).toBe("abc😀def");
  expect(reopened.readOutput("output:shell", 10, 1)).toMatchObject({
    bytes: "",
    nextOffset: 10,
    eof: true,
  });
  expect(reopened.snapshotThread(f.thread.id).items.shell).toMatchObject({
    call: { detail: { output: { bytes: 10, tail: "abc😀def", truncated: false } } },
  });
});
it("limits output reads to 256 KiB and rejects reads before hello or outside readable threads", async () => {
  const f = await fixture({ canReadThread: (_device, id) => id !== ThreadId.parse("denied") });
  cleanups.push(() => f.close());
  const denied = { ...f.thread, id: ThreadId.parse("denied") };
  f.store.appendEvents(denied.id, [
    { type: "thread.created", thread: denied },
    { type: "item.created", item: shell() },
    delta("x".repeat(300 * 1024)),
  ]);
  const unauth = await f.open();
  unauth.send({
    type: "output.read",
    requestId: "u",
    streamId: "output:shell",
    offset: 0,
    limit: 1,
  });
  expect(await unauth.next()).toMatchObject({ type: "error", code: "unauthorized" });
  await expect(unauth.next()).rejects.toThrow("Socket closed");
  const c = await f.connect();
  await c.next();
  c.send({ type: "output.read", requestId: "d", streamId: "output:shell", offset: 0, limit: 1 });
  expect(await c.next()).toMatchObject({ type: "error", code: "read_denied" });
  c.send({ type: "items.page", requestId: "p", threadId: denied.id, before: 100, limit: 1 });
  expect(await c.next()).toMatchObject({ type: "error", code: "read_denied" });
  c.socket.send(
    JSON.stringify({
      type: "output.read",
      requestId: "large",
      streamId: "output:shell",
      offset: 0,
      limit: 256 * 1024 + 1,
    }),
  );
  expect(await c.next()).toMatchObject({ type: "error", code: "invalid_message" });
  const allowed = await f.connect();
  await allowed.next();
  f.store.appendEvents(f.thread.id, [
    { type: "item.created", item: shell("allowed") },
    { ...delta("x".repeat(300 * 1024)), itemId: shell("allowed").id },
  ]);
  allowed.send({
    type: "output.read",
    requestId: "a",
    streamId: "output:allowed",
    offset: 0,
    limit: 256 * 1024,
  });
  const data = await allowed.next();
  if (data.type !== "output.data") throw new Error("Expected output");
  expect(Buffer.from(data.bytes, "base64")).toHaveLength(256 * 1024);
  expect(data.eof).toBe(false);
});
it("caps raw data in live events, replay and snapshots while preserving complete hashed blobs", async () => {
  const f = await setup();
  const c = await f.connect();
  await c.next();
  c.send({
    type: "subscribe",
    subscriptionId: "s",
    scope: { kind: "thread", threadId: f.thread.id },
  });
  await c.next();
  const native = { text: "é".repeat(40 * 1024), unknown: { nested: true } };
  const item = message("raw");
  if (item.type !== "message") throw new Error("Expected message");
  item.raw = [
    { type: "future", name: "read", data: native },
    { type: "small", data: "x".repeat(64 * 1024 - 2) },
  ];
  const events = f.store.appendEvents(f.thread.id, [{ type: "item.created", item }]);
  const live = await c.next();
  expect(live).toMatchObject({ type: "events", events });
  const stored = f.store.snapshotThread(f.thread.id).items.raw;
  if (stored?.type !== "message") throw new Error("Expected message");
  const raw = stored.raw[0];
  if (!raw || !("blobRef" in raw)) throw new Error("Expected capped raw");
  expect(raw).toMatchObject({
    type: "future",
    name: "read",
    size: Buffer.byteLength(JSON.stringify(native)),
  });
  expect(Buffer.byteLength(raw.preview)).toBeLessThanOrEqual(2048);
  expect(raw.preview.startsWith('{"text":"é')).toBe(true);
  expect(stored.raw[1]).toMatchObject({ data: "x".repeat(64 * 1024 - 2) });
  expect(item.raw[0]).toEqual({ type: "future", name: "read", data: native });
  const db = new DatabaseSync(join(f.home, "events.sqlite"));
  cleanups.push(() => db.close());
  const blob = db.prepare("SELECT sha256, bytes FROM blobs WHERE id = ?").get(raw.blobRef)!;
  expect(Buffer.from(blob.bytes as Uint8Array).toString()).toBe(JSON.stringify(native));
  expect(blob.sha256).toBe(createHash("sha256").update(JSON.stringify(native)).digest("hex"));
  const reopened = new Store(join(f.home, "events.sqlite"));
  cleanups.push(() => reopened.close());
  expect(reopened.readEvents({ afterSeq: 1, limit: 1 })).toEqual(events);
  expect(reopened.snapshotThread(f.thread.id).items.raw).toEqual(stored);
  expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThan(70 * 1024);
});
it("rolls output chunks and blobs back with rejected events, then deletes them with their thread", async () => {
  const f = await setup();
  const item = shell();
  if (item.type !== "tool_call") throw new Error("Expected shell");
  item.call.raw = [{ type: "large", data: "r".repeat(100000) }];
  expect(() =>
    f.store.appendEvents(f.thread.id, [
      { type: "item.created", item },
      delta("rolled back"),
      { type: "thread.created", thread: f.thread },
    ]),
  ).toThrow();
  expect(f.store.headSeq()).toBe(1);
  expect(f.store.snapshotThread(f.thread.id).itemOrder).toEqual([]);
  expect(() => f.store.readOutput("output:shell", 0, 100)).toThrow();
  const db = new DatabaseSync(join(f.home, "events.sqlite"));
  cleanups.push(() => db.close());
  expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM output_chunks").get()?.n).toBe(0);
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item }, delta("committed")]);
  expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(1);
  expect(db.prepare("SELECT count(*) AS n FROM output_chunks").get()?.n).toBe(1);
  f.store.deleteThread(f.thread.id);
  expect(f.store.readEvents({ afterSeq: 0, limit: 100 })).toEqual([]);
  expect(f.store.headSeq()).toBe(3);
  expect(f.store.outputThread("output:shell")).toBeUndefined();
  expect(db.prepare("SELECT count(*) AS n FROM blobs").get()?.n).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM output_chunks").get()?.n).toBe(0);
  const next = { ...f.thread, id: ThreadId.parse("next") };
  expect(f.store.appendEvents(next.id, [{ type: "thread.created", thread: next }])[0]?.seq).toBe(4);
});

it.each(["tool", "reasoning", "notice", "interaction", "task", "update"] as const)(
  "caps raw data on %s delivery",
  async (kind) => {
    const f = await setup();
    const raw = [{ type: "future", data: { unknown: "v".repeat(100000) } }];
    let payload: EventPayload;
    if (kind === "tool") {
      const item = shell();
      if (item.type !== "tool_call") throw new Error("Expected tool");
      item.call.raw = raw;
      payload = { type: "item.created", item };
    } else if (kind === "interaction") {
      payload = {
        type: "interaction.opened",
        interaction: Interaction.parse({
          id: "q",
          threadId: f.thread.id,
          agentId: "root",
          blocking: true,
          request: { kind: "approval", title: "Allow", options: [] },
          state: "pending",
          createdAt: 1,
          raw,
        }),
      };
    } else if (kind === "task") {
      payload = {
        type: "background_task.started",
        task: BackgroundTask.parse({
          id: "t",
          agentId: "root",
          kind: "shell",
          title: "Build",
          status: "running",
          stoppable: true,
          startedAt: 1,
          raw,
        }),
      };
    } else {
      const item = Item.parse(
        kind === "update"
          ? { ...message("raw"), raw }
          : {
              id: "raw",
              agentId: "root",
              type: kind,
              text: "Text",
              level: "info",
              createdAt: 1,
              complete: false,
              raw,
            },
      );
      payload = { type: kind === "update" ? "item.updated" : "item.created", item };
    }
    const c = await f.connect();
    await c.next();
    c.send({
      type: "subscribe",
      subscriptionId: "s",
      scope: { kind: "thread", threadId: f.thread.id },
    });
    await c.next();
    f.store.appendEvents(f.thread.id, [payload]);
    const live = await c.next();
    if (live.type !== "events") throw new Error("Expected events");
    const result = live.events[0]!.payload;
    const capped =
      result.type === "interaction.opened"
        ? result.interaction.raw
        : result.type === "background_task.started"
          ? result.task.raw
          : (result.type === "item.created" || result.type === "item.updated") &&
              result.item.type === "tool_call"
            ? result.item.call.raw
            : (result.type === "item.created" || result.type === "item.updated") &&
                "raw" in result.item
              ? result.item.raw
              : [];
    expect(capped[0]).toMatchObject({
      type: "future",
      blobRef: expect.any(String),
      size: Buffer.byteLength(JSON.stringify(raw[0]!.data)),
    });
    expect(Buffer.byteLength(JSON.stringify(live))).toBeLessThan(4096);
    expect(f.store.readEvents({ afterSeq: 1, limit: 1 })[0]?.payload).toEqual(result);
  },
);
