import { afterEach, expect, test } from "vitest";
import { AgentId, InteractionId, DeviceId } from "@ace/protocol";
import type { CommandHandler } from "@ace/daemon";
import { setup, ready, when, barrier, memoryStorage } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("a persisted outbox replays after restart and an accepted command applies exactly once", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const first = h.make({ storage: h.storage });
  await ready(first.client);
  first.faults.incoming = (message, frame, deliver) => {
    if (message.type !== "commandResult") deliver(frame);
  };
  const id = await first.client.enqueue(
    { type: "thread.archive", threadId: h.thread.id },
    "archive-once",
  );
  await first.faults.wait((message) => message.type === "commandResult");
  expect(first.client.intent(id).getSnapshot()?.state).toBe("pending");
  first.client.close();
  const second = h.make({ storage: h.storage });
  await ready(second.client);
  await when(second.client.intent(id), (intent) => intent?.state === "acked");
  const archived = h.daemon.store
    .readEvents({ afterSeq: 0, threadId: h.thread.id, limit: 100 })
    .filter(
      (event) => event.payload.type === "thread.updated" && event.payload.archivedAt !== undefined,
    );
  expect(archived).toHaveLength(1);
});

test("offline sends persist and replay when the network returns", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make({ storage: h.storage });
  await ready(client);
  client.networkOnline(false);
  const id = await client.enqueue({ type: "thread.archive", threadId: h.thread.id });
  expect(client.intent(id).getSnapshot()?.state).toBe("pending");
  expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeUndefined();
  client.networkOnline(true);
  await when(client.intent(id), (intent) => intent?.state === "acked");
  expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeDefined();
});

test("a failed persistence write never sends a command", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make({
    storage: {
      async load() {
        return null;
      },
      async save() {
        throw new Error("disk full");
      },
    },
  });
  await ready(client);
  await expect(
    client.enqueue({ type: "thread.archive", threadId: h.thread.id }),
  ).rejects.toMatchObject({ code: "storage" });
  await barrier(client, h.thread.id);
  expect(h.daemon.store.getThread(h.thread.id)?.archivedAt).toBeUndefined();
});

test("queued intent capacity rejects excess offline sends without losing pending work", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make({ limits: { intents: 1 } });
  await ready(client);
  client.networkOnline(false);
  await client.enqueue({ type: "thread.archive", threadId: h.thread.id }, "first");
  await expect(
    client.enqueue({ type: "thread.archive", threadId: h.thread.id }, "second"),
  ).rejects.toMatchObject({ code: "limit" });
  expect(client.intent("first").getSnapshot()?.state).toBe("pending");
  client.networkOnline(true);
  await when(client.intent("first"), (intent) => intent?.state === "acked");
});

test("an idempotency key cannot silently change its command", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make();
  await ready(client);
  client.networkOnline(false);
  await client.enqueue({ type: "thread.archive", threadId: h.thread.id }, "same-key");
  await expect(
    client.enqueue({ type: "thread.interrupt", threadId: h.thread.id, cascade: true }, "same-key"),
  ).rejects.toMatchObject({ code: "protocol" });
});

test("stored credentials for another device are rejected before connecting", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const storage = memoryStorage();
  await storage.save(
    JSON.stringify([
      {
        state: "pending",
        command: {
          id: "old",
          deviceId: "different-device",
          payload: { type: "thread.archive", threadId: h.thread.id },
        },
      },
    ]),
  );
  const { client, faults } = h.make({ storage });
  await expect(client.start()).rejects.toMatchObject({ code: "storage" });
  expect(client.state).toBe("fatal");
  expect(faults.sent).toHaveLength(0);
});

test("the first interaction answer wins and a later daemon rejection becomes a failed intent", async () => {
  const interactionId = InteractionId.parse("approval");
  const handler: CommandHandler = {
    handle(command, store) {
      if (command.payload.type !== "interaction.resolve")
        return { commandId: command.id, ok: false, error: "not_implemented" };
      const events = store.readEvents({ afterSeq: 0, limit: 100 });
      const threadId = events[0]?.threadId;
      if (!threadId) throw new Error("missing thread");
      if (events.some((event) => event.payload.type === "interaction.closed"))
        return { commandId: command.id, ok: false, error: "already_resolved" };
      store.appendEvents(threadId, [
        {
          type: "interaction.closed",
          interactionId,
          state: "resolved",
          closedAt: 2,
          resolvedBy: command.deviceId,
          resolution: command.payload.resolution,
        },
      ]);
      return { commandId: command.id, ok: true };
    },
  };
  const h = await setup(handler);
  cleanup = h.cleanup;
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "interaction.opened",
      interaction: {
        id: interactionId,
        threadId: h.thread.id,
        agentId: AgentId.parse("agent"),
        blocking: true,
        state: "pending",
        createdAt: 1,
        request: { kind: "approval", title: "Allow?", options: [] },
        raw: [],
      },
    },
  ]);
  const one = h.make();
  const two = h.make({ deviceId: DeviceId.parse("other-device") });
  await ready(one.client);
  await ready(two.client);
  const payload = {
    type: "interaction.resolve" as const,
    interactionId,
    resolution: { kind: "approval" as const, optionId: "allow" },
  };
  const first = await one.client.command(payload);
  const second = await two.client.command(payload);
  expect(first.ok).toBe(true);
  expect(second).toMatchObject({ ok: false, error: "already_resolved" });
  await when(two.client.intent(second.commandId), (intent) => intent?.state === "failed");
  expect(
    h.daemon.store
      .readEvents({ afterSeq: 0, limit: 100 })
      .filter((event) => event.payload.type === "interaction.closed"),
  ).toHaveLength(1);
});

test("retrying an acknowledged command returns its receipt without repeating its effect", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const { client } = h.make();
  await ready(client);
  const payload = { type: "thread.archive" as const, threadId: h.thread.id };
  const first = await client.command(payload, {}, "repeat");
  await when(client.intent("repeat"), (intent) => intent?.state === "acked");
  expect(await client.command(payload, {}, "repeat")).toEqual(first);
  expect(
    h.daemon.store
      .readEvents({ afterSeq: 0, limit: 100 })
      .filter((event) => event.payload.type === "thread.updated"),
  ).toHaveLength(1);
});

test("an oversized daemon rejection cannot grow the persisted outbox beyond its byte cap", async () => {
  const h = await setup({
    handle(command) {
      return { commandId: command.id, ok: false, error: "x".repeat(1000) };
    },
  });
  cleanup = h.cleanup;
  const storage = memoryStorage();
  const { client } = h.make({ storage, limits: { outboxBytes: 512 } });
  await ready(client);
  const id = await client.enqueue({ type: "thread.archive", threadId: h.thread.id });
  await when(client.connectionState(), (state) => state === "fatal");
  expect(client.intent(id).getSnapshot()?.state).toBe("pending");
  expect((await storage.load())?.length).toBeLessThanOrEqual(512);
});
