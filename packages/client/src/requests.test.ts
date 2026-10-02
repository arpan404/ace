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
    if (event.type === "response" && !held) {
      held = frame;
      deliverHeld = deliver;
    } else deliver(frame);
  };
  const request = client.itemsPage({ threadId: h.thread.id, limit: 1 }, { timeoutMs: 100 });
  const rejected = expect(request).rejects.toMatchObject({ code: "timeout" });
  await faults.wait((event) => event.type === "response");
  scheduler.advance(100);
  await rejected;
  if (held) deliverHeld?.(held);
  expect(await client.itemsPage({ threadId: h.thread.id, limit: 1 })).toMatchObject({
    type: "items.page",
    items: [],
  });
});

test("abort cancels an in-flight request and a pre-aborted read sends nothing", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make();
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (event.type !== "response") deliver(frame);
  };
  const controller = new AbortController();
  const request = client.itemsPage(
    { threadId: h.thread.id, limit: 1 },
    { signal: controller.signal },
  );
  const rejected = expect(request).rejects.toMatchObject({ code: "aborted" });
  await faults.wait((event) => event.type === "response");
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
    if (event.type !== "response") deliver(frame);
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

test("command timeout leaves its durable intent pending until the accepted receipt returns", async () => {
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
  const rejected = expect(request).rejects.toMatchObject({ code: "timeout" });
  await faults.wait((event) => event.type === "commandResult");
  scheduler.advance(100);
  await rejected;
  expect(client.intent("slow-ack").getSnapshot()?.state).toBe("pending");
  if (receipt) deliverReceipt?.(receipt);
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
          detail: { kind: "shell", command: "echo", output: "abcdef" },
          raw: [],
        },
      },
    },
  ]);
  const { client } = h.make();
  await ready(client);
  const stream = client.output({ threadId: h.thread.id, itemId: id, offset: 0, limit: 2 });
  expect(await stream.next()).toEqual({ value: "ab", done: false });
  expect(await stream.next()).toEqual({ value: "cd", done: false });
  expect(await stream.next()).toEqual({ value: "ef", done: false });
  expect((await stream.next()).done).toBe(true);
});

test("oversized frames fail without buffering or parsing more traffic", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client, faults } = h.make({ limits: { frameBytes: 300 } });
  await ready(client);
  faults.incoming = (event, frame, deliver) => {
    if (event.type === "response") deliver(" ".repeat(301));
    else deliver(frame);
  };
  const request = client.itemsPage({ threadId: h.thread.id, limit: 1 });
  await expect(request).rejects.toMatchObject({ code: "offline" });
  expect(client.state).toBe("fatal");
  expect(client.error?.code).toBe("limit");
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
          detail: { kind: "shell", command: "echo", output: "éA🌍Z" },
        },
      },
    },
  ]);
  const { client } = h.make();
  await ready(client);
  const first = await client.outputRead({ threadId: h.thread.id, itemId: id, offset: 0, limit: 3 });
  expect(first).toMatchObject({ text: "éA", nextOffset: 2, done: false });
  const next = await client.outputRead({ threadId: h.thread.id, itemId: id, offset: 2, limit: 4 });
  expect(next).toMatchObject({ text: "🌍", nextOffset: 4, done: false });
  expect(
    await client.outputRead({ threadId: h.thread.id, itemId: id, offset: 4, limit: 1 }),
  ).toMatchObject({ text: "Z", done: true });
});
