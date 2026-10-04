import { afterEach, expect, test } from "vitest";
import { AgentId, ItemId } from "@ace/protocol";
import { setup, ready, when, memoryStorage } from "./test-support.ts";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

test("a send is visible while storage is held and becomes its admission item without changing its key", async () => {
  const h = await setup({ handle: (command) => ({ commandId: command.id, ok: true }) });
  cleanup = h.cleanup;
  const storage = memoryStorage();
  const gate = Promise.withResolvers<void>();
  let held = false;
  const { client, scheduler } = h.make({
    storage: {
      load: () => storage.load(),
      save: async (value) => {
        if (held) await gate.promise;
        await storage.save(value);
      },
    },
  });
  await ready(client);
  const lease = client.thread(h.thread.id);
  held = true;
  const selection = client.pendingSends(h.thread.id);
  const send = client.enqueue(
    {
      type: "thread.send",
      threadId: h.thread.id,
      input: [{ type: "text", text: "Keep my message" }],
      delivery: "queue",
    },
    "pending-send",
  );
  expect(selection.getSnapshot()).toMatchObject([
    { itemId: "input:pending-send", state: "saving" },
  ]);
  held = false;
  gate.resolve();
  await send;
  await when(selection, (entries) => entries[0]?.state === "accepted");
  h.daemon.store.appendEvents(h.thread.id, [
    {
      type: "item.created",
      item: {
        type: "message",
        id: ItemId.parse("input:pending-send"),
        agentId: AgentId.parse("agent"),
        createdAt: 1,
        role: "user",
        complete: true,
        synthetic: false,
        raw: [],
        parts: [{ type: "text", text: "Keep my message" }],
      },
    },
  ]);
  await when(selection, (entries) => entries[0]?.state === "delivered");
  scheduler.advance(5_000);
  expect(selection.getSnapshot()).toMatchObject([{ itemId: "input:pending-send", waiting: false }]);
  expect(lease.store.order.filter((id) => id === "input:pending-send")).toHaveLength(1);
  expect(await storage.load()).toBe("[]");
  lease.release();
});

test("a slow durable create keeps its provisional route addressable after acceptance", async () => {
  const h = await setup({
    handle: (command) => ({ commandId: command.id, ok: true, threadId: h.thread.id }),
  });
  cleanup = h.cleanup;
  const { client, faults, scheduler } = h.make();
  await ready(client);
  let release: (() => void) | undefined;
  faults.incoming = (message, frame, deliver) => {
    if (message.type === "commandResult") release = () => deliver(frame);
    else deliver(frame);
  };
  const result = client.command(
    {
      type: "thread.create",
      workspaceId: h.workspaceId,
      provider: "claude",
      input: [{ type: "text", text: "Create once" }],
      mode: "worktree",
    },
    {},
    "draft-id",
  );
  const selection = client.pendingSends("pending:draft-id");
  await faults.wait((message) => message.type === "commandResult");
  scheduler.advance(5_000);
  expect(selection.getSnapshot()).toMatchObject([{ commandId: "draft-id", waiting: true }]);
  release?.();
  await result;
  await when(selection, (entries) => entries[0]?.state === "accepted");
  expect(selection.getSnapshot()).toMatchObject([
    { threadId: h.thread.id, itemId: "input:draft-id" },
  ]);
});

test("a storage refusal keeps the pending bubble and same-id retry preserves its input", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  let fail = false;
  const storage = memoryStorage();
  const { client } = h.make({
    storage: {
      load: () => storage.load(),
      save: (value) => {
        if (fail) return Promise.reject(new Error("disk full"));
        return storage.save(value);
      },
    },
  });
  await ready(client);
  client.networkOnline(false);
  fail = true;
  const payload = {
    type: "thread.send" as const,
    threadId: h.thread.id,
    input: [{ type: "text" as const, text: "Do not lose me" }],
  };
  await expect(client.enqueue(payload, "retry-me")).rejects.toMatchObject({ code: "storage" });
  expect(client.pendingSends(h.thread.id).getSnapshot()).toMatchObject([
    { state: "failed", payload },
  ]);
  fail = false;
  await client.enqueue(payload, "retry-me");
  expect(client.pendingSends(h.thread.id).getSnapshot()).toMatchObject([
    { state: "sent", commandId: "retry-me", payload },
  ]);
});
