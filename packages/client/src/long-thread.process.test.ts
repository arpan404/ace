import { expect, test } from "vitest";
import { createDevThread } from "@ace/daemon";
import { Interaction, type EventPayload } from "@ace/protocol";
import { setup, ready, when, barrier, message, itemId } from "./test-support.ts";

test("deleting an item notifies its readers and an older page cannot resurrect it", async () => {
  const h = await setup();
  try {
    h.daemon.store.appendEvents(h.thread.id, [message]);
    const { client, faults } = h.make();
    await ready(client);
    const { store } = client.thread(h.thread.id);
    const selected = store.select([`item:${itemId}`], (reader) => reader.item(itemId));
    await when(selected, Boolean);
    let page: (() => void) | undefined;
    faults.incoming = (incoming, text, deliver) => {
      if (incoming.type === "items.page") page = () => deliver(text);
      else deliver(text);
    };
    const loading = client.itemsPage({ threadId: h.thread.id, limit: 1 });
    await faults.wait((incoming) => incoming.type === "items.page");
    h.daemon.store.appendEvents(h.thread.id, [{ type: "item.deleted", itemId }]);
    await when(selected, (item) => item === undefined);
    page?.();
    store.page(await loading);
    expect(store.item(itemId)).toBeUndefined();
    expect(store.order).not.toContain(itemId);
  } finally {
    await h.cleanup();
  }
});

test("pending approvals above the old entity cap arrive through bounded snapshot frames", async () => {
  const h = await setup();
  try {
    for (let start = 0; start < 10000; start += 100) {
      const events: EventPayload[] = [];
      for (let i = start; i < Math.min(10000, start + 100); i++)
        events.push({
          type: "interaction.opened",
          interaction: Interaction.parse({
            id: `open-${i}`,
            threadId: h.thread.id,
            agentId: "root",
            blocking: true,
            state: "pending",
            createdAt: i,
            request: { kind: "approval", title: "a".repeat(600), options: [] },
          }),
        });
      h.daemon.store.appendEvents(h.thread.id, events);
    }
    const { client, faults } = h.make();
    let largest = 0;
    faults.incoming = (_incoming, text, deliver) => {
      largest = Math.max(largest, Buffer.byteLength(text));
      deliver(text);
    };
    await ready(client);
    const { store } = client.thread(h.thread.id);
    await when(
      store.select(["interactions"], (reader) => reader.interactionIds().length),
      (count) => count === 10000,
    );
    expect(client.state).toBe("ready");
    expect(store.error).toBeUndefined();
    expect(largest).toBeLessThan(2 * 1024 * 1024);
  } finally {
    await h.cleanup();
  }
});

test("reconnect starts at most four subscriptions until their replay completion arrives", async () => {
  const h = await setup();
  try {
    const { client, faults } = h.make();
    await ready(client);
    const releases: (() => void)[] = [];
    const held: (() => void)[] = [];
    faults.incoming = (incoming, text, deliver) => {
      if (incoming.type === "subscription.ready") held.push(() => deliver(text));
      else deliver(text);
    };
    const ids = Array.from({ length: 12 }, () => createDevThread(h.daemon.store, h.workspaceId).id);
    for (const id of ids) releases.push(client.thread(id).release);
    await barrier(client, h.thread.id);
    const subscribes = () =>
      faults.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "subscribe");
    expect(subscribes()).toHaveLength(4);
    expect(held).toHaveLength(4);
    for (const finish of held.splice(0)) finish();
    await barrier(client, h.thread.id);
    expect(subscribes()).toHaveLength(8);
    for (const release of releases) release();
  } finally {
    await h.cleanup();
  }
});

test("offline command replay admits eight in flight and advances when durable replies arrive", async () => {
  const h = await setup();
  try {
    const { client, faults } = h.make();
    await ready(client);
    client.networkOnline(false);
    for (let i = 0; i < 20; i++)
      await client.enqueue({ type: "thread.archive", threadId: h.thread.id }, `replay-${i}`);
    const held: (() => void)[] = [];
    faults.incoming = (incoming, text, deliver) => {
      if (incoming.type === "commandResult") held.push(() => deliver(text));
      else deliver(text);
    };
    client.networkOnline(true);
    await when(client.connectionState(), (state) => state === "ready");
    await barrier(client, h.thread.id);
    const commands = () =>
      faults.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "command");
    expect(commands()).toHaveLength(8);
    const first = held.shift();
    first?.();
    await when(client.intent("replay-0"), (intent) => intent?.state === "acked");
    await barrier(client, h.thread.id);
    expect(commands()).toHaveLength(9);
    faults.incoming = (_incoming, text, deliver) => deliver(text);
    for (const release of held) release();
    await when(client.intent("replay-19"), (intent) => intent?.state === "acked");
    expect(commands()).toHaveLength(20);
  } finally {
    await h.cleanup();
  }
});

test("a refused subscription releases its replay slot without endlessly retrying itself", async () => {
  const h = await setup();
  try {
    const { client, faults } = h.make();
    await ready(client);
    const missing = client.thread("missing-thread");
    const healthy = client.thread(h.thread.id);
    await barrier(client, h.thread.id);
    await barrier(client, h.thread.id);
    expect(missing.store.error).toBeDefined();
    expect(healthy.store.thread?.id).toBe(h.thread.id);
    const requests = faults.sent
      .map((text) => JSON.parse(text))
      .filter((frame) => frame.type === "subscribe" && frame.scope.threadId === "missing-thread");
    expect(requests).toHaveLength(1);
    missing.release();
    healthy.release();
  } finally {
    await h.cleanup();
  }
});
