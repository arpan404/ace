import { afterEach, expect, test } from "vitest";
import { ItemId } from "@ace/protocol";
import { setup, ready, agentId, barrier, when } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("a request deadline rejects the waiter and a late response does not poison later reads", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make();
  await ready(client);
  let held: string | undefined;
  let deliverHeld: ((text: string) => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "items.page" && !held) {
      held = frame;
      deliverHeld = deliver;
    } else deliver(frame);
  };
  const request = client.itemsPage({ threadId: h.thread.id, limit: 1 }, { timeoutMs: 100 });
  const rejected = expect(request).rejects.toMatchObject({ code: "timeout" });
  await faults.wait((event) => event.type === "items.page");
  scheduler.advance(100);
  await rejected;
  if (held) deliverHeld?.(held);
  expect(await client.itemsPage({ threadId: h.thread.id, limit: 1 })).toMatchObject({
    items: [],
  });
});

test("abort cancels an in-flight request and a pre-aborted read sends nothing", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "items.page") deliver(frame);
  };
  const controller = new AbortController();
  const request = client.itemsPage(
    { threadId: h.thread.id, limit: 1 },
    { signal: controller.signal },
  );
  const rejected = expect(request).rejects.toMatchObject({ code: "aborted" });
  await faults.wait((event) => event.type === "items.page");
  controller.abort();
  await rejected;
  const count = faults.sent.length;
  await expect(
    client.itemsPage({ threadId: h.thread.id, limit: 1 }, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(faults.sent).toHaveLength(count);
});

test("request capacity bounds outstanding correlations and frees capacity after abort", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make({ limits: { requests: 1 } });
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "items.page") deliver(frame);
  };
  const controller = new AbortController();
  const first = client.itemsPage(
    { threadId: h.thread.id, limit: 1 },
    { signal: controller.signal },
  );
  const rejected = expect(first).rejects.toMatchObject({ code: "aborted" });
  await expect(client.itemsPage({ threadId: h.thread.id, limit: 1 })).rejects.toMatchObject({
    code: "limit",
  });
  controller.abort();
  await rejected;
  faults.incoming = (_event, frame, deliver) => deliver(frame);
  await barrier(client, h.thread.id);
});

test("a durable command keeps waiting past a deadline until the accepted receipt returns", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make();
  await ready(client);
  let receipt: string | undefined;
  let deliverReceipt: ((frame: string) => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "commandResult") {
      receipt = frame;
      deliverReceipt = deliver;
    } else deliver(frame);
  };
  const request = client.command(
    { type: "thread.archive", threadId: h.thread.id },
    { timeoutMs: 100 },
    "slow-ack",
  );
  let finished = false;
  void request.then(() => {
    finished = true;
  });
  await faults.wait((event) => event.type === "commandResult");
  scheduler.advance(20_000);
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(client.intent("slow-ack").getSnapshot()?.state).toBe("pending");
  if (receipt) deliverReceipt?.(receipt);
  expect(await request).toMatchObject({ ok: true, commandId: "slow-ack" });
  await when(client.intent("slow-ack"), (intent) => intent?.state === "acked");
});

test("lazy output reads fetch successive chunks without accumulating output in the SDK", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const id = ItemId.parse("shell");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: {
        type: "tool_call",
        id,
        agentId,
        createdAt: 1,
        complete: true,
        call: {
          id,
          agentId,
          kind: "shell",
          title: "echo",
          startedAt: 1,
          status: "succeeded",
          detail: { kind: "shell", command: "echo" },
          raw: [],
        },
      },
    },
  ]);
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.delta", itemId: id, agentId, field: "output", append: "abcdef" },
  ]);
  const { client, faults } = h.make();
  await ready(client);
  const stream = client.output({ streamId: `output:${id}`, offset: 0, limit: 2 });
  const reads = () => faults.sent.filter((s) => JSON.parse(s).type === "output.read").length;
  expect(reads()).toBe(0);
  expect(await stream.next()).toEqual({ value: new TextEncoder().encode("ab"), done: false });
  expect(reads()).toBe(1);
  expect(await stream.next()).toEqual({ value: new TextEncoder().encode("cd"), done: false });
  expect(await stream.next()).toEqual({ value: new TextEncoder().encode("ef"), done: false });
  expect(reads()).toBe(3);
  expect((await stream.next()).done).toBe(true);
  expect(reads()).toBe(3);
});

test("oversized frames fail without buffering or parsing more traffic", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make({ limits: { frameBytes: 300 } });
  await ready(client);
  let late: (() => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "items.page") {
      late = () =>
        deliver(
          JSON.stringify({
            type: "welcome",
            hostId: "late-daemon",
            protocolVersion: 1,
            headSeq: 0,
          }),
        );
      deliver(" ".repeat(301));
    } else deliver(frame);
  };
  const request = client.itemsPage({ threadId: h.thread.id, limit: 1 });
  await expect(request).rejects.toMatchObject({ code: "offline" });
  expect(client.state).toBe("fatal");
  expect(client.error?.code).toBe("limit");
  late?.();
  const sent = faults.sent.length;
  await expect(client.itemsPage({ threadId: h.thread.id, limit: 1 })).rejects.toMatchObject({
    code: "offline",
  });
  expect(client.error?.code).toBe("limit");
  expect(faults.sent).toHaveLength(sent);
});

test("output read byte limits preserve Unicode characters across chunks", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const id = ItemId.parse("unicode");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: {
        type: "tool_call",
        id,
        agentId,
        createdAt: 1,
        complete: true,
        call: {
          id,
          agentId,
          kind: "shell",
          title: "unicode",
          startedAt: 1,
          status: "succeeded",
          raw: [],
          detail: { kind: "shell", command: "echo" },
        },
      },
    },
  ]);
  h.daemon.store.appendEvents(h.thread.id, [
    { type: "item.delta", itemId: id, agentId, field: "output", append: "éA🌍Z" },
  ]);
  const { client } = h.make();
  await ready(client);
  const first = await client.outputRead({ streamId: `output:${id}`, offset: 0, limit: 3 });
  expect(first).toMatchObject({ bytes: new TextEncoder().encode("éA"), nextOffset: 3, eof: false });
  const next = await client.outputRead({ streamId: `output:${id}`, offset: 3, limit: 4 });
  expect(next).toMatchObject({ bytes: new TextEncoder().encode("🌍"), nextOffset: 7, eof: false });
  expect(await client.outputRead({ streamId: `output:${id}`, offset: 7, limit: 1 })).toMatchObject({
    bytes: new TextEncoder().encode("Z"),
    eof: true,
  });
});

test("durable command capacity supplies unsent evidence without reserving an intent and permits retry", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make({ limits: { requests: 1 } });
  await ready(client);
  const controller = new AbortController();
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "items.page") deliver(frame);
  };
  const read = client.itemsPage({ threadId: h.thread.id, limit: 1 }, { signal: controller.signal });
  const aborted = expect(read).rejects.toMatchObject({ code: "aborted" });
  await faults.wait((event) => event.type === "items.page");
  const payload = { type: "thread.archive", threadId: h.thread.id } as const;
  await expect(
    client.command(payload, { admission: "fresh" }, "capacity-refused"),
  ).rejects.toMatchObject({
    code: "not_dispatched",
  });
  expect(client.intent("capacity-refused").getSnapshot()).toBeUndefined();
  expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeUndefined();
  controller.abort();
  await aborted;
  expect(await client.command(payload, {}, "capacity-refused")).toMatchObject({ ok: true });
  expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeDefined();
});

test("a duplicate durable waiter at capacity keeps the admitted command uncertain until its original receipt arrives", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make({ limits: { requests: 1 } });
  await ready(client);
  const receipt = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "commandResult" && event.commandId === "already-admitted") {
      release = () => deliver(frame);
      receipt.resolve();
    } else deliver(frame);
  };
  const payload = { type: "thread.archive", threadId: h.thread.id } as const;
  const original = client.command(payload, {}, "already-admitted");
  await receipt.promise;
  await expect(client.command(payload, {}, "already-admitted")).rejects.toMatchObject({
    code: "limit",
  });
  expect(client.intent("already-admitted").getSnapshot()?.state).toBe("pending");
  release?.();
  expect(await original).toMatchObject({ ok: true });
});

test("an acknowledged command replay at capacity stays uncertain after restart removes its persisted intent", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const original = h.make({ storage: h.storage }).client;
  await ready(original);
  const payload = { type: "thread.archive", threadId: h.thread.id } as const;
  expect(await original.command(payload, { admission: "fresh" }, "trimmed-receipt")).toMatchObject({
    ok: true,
  });
  await original.close();
  expect(JSON.parse((await h.storage.load()) ?? "null")).toEqual([]);
  const { client, faults } = h.make({ storage: h.storage, limits: { requests: 1 } });
  await ready(client);
  expect(client.intent("trimmed-receipt").getSnapshot()).toBeUndefined();
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "items.page") deliver(frame);
  };
  const controller = new AbortController();
  const read = client.itemsPage({ threadId: h.thread.id, limit: 1 }, { signal: controller.signal });
  const cancelled = expect(read).rejects.toMatchObject({ code: "aborted" });
  await faults.wait((event) => event.type === "items.page");
  try {
    await expect(client.command(payload, {}, "trimmed-receipt")).rejects.toMatchObject({
      code: "limit",
    });
    expect(client.intent("trimmed-receipt").getSnapshot()?.localFailure).toBeUndefined();
  } finally {
    controller.abort();
    await cancelled;
  }
});

test("settled intent eviction does not turn a known-ID capacity refusal into unsent evidence", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make({ limits: { requests: 1, intents: 1 } });
  await ready(client);
  const payload = { type: "thread.archive", threadId: h.thread.id } as const;
  expect(await client.command(payload, {}, "evicted-receipt")).toMatchObject({ ok: true });
  await client.command(payload, {}, "later-receipt");
  expect(client.intent("evicted-receipt").getSnapshot()).toBeUndefined();
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "items.page") deliver(frame);
  };
  const controller = new AbortController();
  const read = client.itemsPage({ threadId: h.thread.id, limit: 1 }, { signal: controller.signal });
  const cancelled = expect(read).rejects.toMatchObject({ code: "aborted" });
  await faults.wait((event) => event.type === "items.page");
  try {
    await expect(client.command(payload, {}, "evicted-receipt")).rejects.toMatchObject({
      code: "limit",
    });
  } finally {
    controller.abort();
    await cancelled;
  }
});
