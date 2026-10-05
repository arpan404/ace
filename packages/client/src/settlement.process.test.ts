import { afterEach, expect, test } from "vitest";
import { AdapterRegistry } from "@ace/daemon";
import { createTurnProvider, ScriptedTurnConfig } from "@ace/adapter-testkit";
import { setup, ready, when, memoryStorage } from "./test-support.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

// Reproduces review blockers 1 and 2 through the real engine. No admission facts are injected.
test("200 large real-engine sends never block the 201st without a transcript lease, including after reload", async () => {
  const registry = new AdapterRegistry();
  registry.register(
    createTurnProvider({
      provider: "codex",
      reply: "Scripted reply",
      config: ScriptedTurnConfig.parse({}),
      now: () => 1000,
      schedule: () => () => {},
    }),
    { installed: true, auth: "logged_in", loginHint: "scripted boundary" },
  );
  const h = await setup(undefined, undefined, { registry });
  cleanup = h.cleanup;
  const storage = memoryStorage();
  const first = h.make({ storage, limits: { intents: 2, outboxBytes: 300_000 } }).client;
  await ready(first);
  const created = await first.command(
    {
      type: "thread.create",
      workspaceId: h.workspaceId,
      provider: "codex",
      input: [{ type: "text", text: "Begin" }],
    },
    {},
    "real-create",
  );
  if (!created.threadId) throw new Error("Expected real thread");
  for (let i = 0; i <= 200; i++) {
    const id = `real-send-${i}`;
    expect(
      await first.command(
        {
          type: "thread.send",
          threadId: created.threadId,
          delivery: "queue",
          input: [{ type: "text", text: "x".repeat(240 * 1024) }],
        },
        {},
        id,
      ),
    ).toMatchObject({ ok: true });
    await when(first.intent(id), (value) => value?.state === "acked");
    expect(await storage.load()).toBe("[]");
  }
  const page = await first.itemsPage({ threadId: created.threadId, limit: 200 });
  expect(page.items.some((item) => item.id === "input:real-send-200")).toBe(true);
  await when(first.intent("real-send-200"), (value) => value?.delivered === true);
  expect(
    first
      .pendingSends(created.threadId)
      .getSnapshot()
      .find((entry) => entry.commandId === "real-send-200"),
  ).toMatchObject({ state: "delivered" });
  await first.close();
  const second = h.make({ storage }).client;
  await ready(second);
  expect(second.pendingSends().getSnapshot()).toEqual([]);
  expect(
    (await second.itemsPage({ threadId: created.threadId, limit: 200 })).items.filter(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        item.origin?.commandId === "real-send-200",
    ),
  ).toHaveLength(1);
});

test("oversized rejected drafts are never published or retained and storage failures remain bounded", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const client = h.make({
    limits: { sendBytes: 1024, intents: 3, outboxBytes: 4096 },
    storage: {
      load: async () => null,
      save: async () => {
        throw new Error("disk full");
      },
    },
  }).client;
  await ready(client);
  client.networkOnline(false);
  let changed = 0;
  const selection = client.pendingSends();
  const stop = selection.subscribe(() => changed++);
  for (let i = 0; i < 30; i++)
    await expect(
      client.enqueue(
        {
          type: "thread.send",
          threadId: h.thread.id,
          input: [{ type: "text", text: "x".repeat(2048) }],
        },
        `huge-${i}`,
      ),
    ).rejects.toMatchObject({ code: "limit" });
  expect(changed).toBe(0);
  expect(selection.getSnapshot()).toEqual([]);
  for (let i = 0; i < 30; i++)
    await expect(
      client.enqueue(
        {
          type: "thread.send",
          threadId: h.thread.id,
          input: [{ type: "text", text: "Keep this bounded draft" }],
        },
        `failed-${i}`,
      ),
    ).rejects.toMatchObject({ code: "storage" });
  expect(selection.getSnapshot().length).toBeLessThanOrEqual(3);
  expect(selection.getSnapshot().at(-1)).toMatchObject({ commandId: "failed-29", state: "failed" });
  expect(client.intent("failed-0").getSnapshot()).toBeUndefined();
  stop();
});

test("a real provider delivery failure correlates to the accepted draft and retains its original input", async () => {
  const registry = new AdapterRegistry();
  const adapter = createTurnProvider({
    provider: "codex",
    reply: "unused",
    config: ScriptedTurnConfig.parse({}),
    now: () => 1000,
    schedule: () => () => {},
  });
  registry.register(
    {
      ...adapter,
      async openSession() {
        throw new Error("Scripted provider unavailable");
      },
    },
    { installed: true, auth: "logged_in", loginHint: "scripted failure boundary" },
  );
  const h = await setup(undefined, undefined, { registry });
  cleanup = h.cleanup;
  const storage = memoryStorage();
  const { client } = h.make({ storage });
  await ready(client);
  const input = [{ type: "text", text: "Keep my failed draft" }] as const;
  const result = await client.command(
    { type: "thread.create", workspaceId: h.workspaceId, provider: "codex", input: [...input] },
    {},
    "delivery-failed",
  );
  expect(result.ok).toBe(true);
  if (!result.threadId) throw new Error("Expected admitted thread");
  const lease = client.thread(result.threadId);
  await when(client.intent("delivery-failed"), (value) => value?.state === "failed");
  expect(client.pendingSends(result.threadId).getSnapshot()).toContainEqual(
    expect.objectContaining({
      commandId: "delivery-failed",
      state: "failed",
      payload: expect.objectContaining({ input }),
      error: expect.stringContaining("Scripted provider unavailable"),
    }),
  );
  const page = await client.itemsPage({ threadId: result.threadId, limit: 100 });
  expect(page.items).toContainEqual(
    expect.objectContaining({ type: "notice", commandId: "delivery-failed", level: "error" }),
  );
  expect(await storage.load()).toBe("[]");
  lease.release();
});

test("an aggregate save cannot persist another draft before its own write succeeds", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  const disk = memoryStorage();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const storage = {
    load: () => disk.load(),
    async save(value: string) {
      if (++writes === 1) {
        entered.resolve();
        await release.promise;
        await disk.save(value);
      } else throw new Error("second draft write failed");
    },
  };
  const { client } = h.make({ storage });
  await ready(client);
  client.networkOnline(false);
  const payload = {
    type: "thread.send" as const,
    threadId: h.thread.id,
    input: [{ type: "text" as const, text: "Only persist after my own save" }],
  };
  const first = client.enqueue(payload, "saved-first");
  await entered.promise;
  const second = client.enqueue(payload, "not-saved");
  const failed = expect(second).rejects.toMatchObject({ code: "storage" });
  release.resolve();
  await first;
  await failed;
  expect(JSON.parse((await disk.load()) ?? "[]")).toMatchObject([
    { command: { id: "saved-first" }, state: "pending" },
  ]);
  expect(JSON.parse((await disk.load()) ?? "[]")).toHaveLength(1);
  expect(
    client
      .pendingSends()
      .getSnapshot()
      .find((entry) => entry.commandId === "not-saved"),
  ).toMatchObject({ state: "failed" });
});

test("failed drafts have their own retention cap while pending sends remain protected", async () => {
  const h = await setup();
  cleanup = h.cleanup;
  let fail = false;
  const disk = memoryStorage();
  const { client } = h.make({
    limits: { intents: 100 },
    storage: {
      load: () => disk.load(),
      save: (value) => (fail ? Promise.reject(new Error("disk full")) : disk.save(value)),
    },
  });
  await ready(client);
  client.networkOnline(false);
  const payload = {
    type: "thread.send" as const,
    threadId: h.thread.id,
    input: [{ type: "text" as const, text: "Preserve input" }],
  };
  await client.enqueue(payload, "protected-pending");
  fail = true;
  for (let i = 0; i < 70; i++)
    await expect(client.enqueue(payload, `failed-cap-${i}`)).rejects.toMatchObject({
      code: "storage",
    });
  expect(
    client
      .pendingSends()
      .getSnapshot()
      .filter((entry) => entry.state === "failed"),
  ).toHaveLength(64);
  expect(client.intent("protected-pending").getSnapshot()).toMatchObject({ state: "pending" });
  expect(client.intent("failed-cap-0").getSnapshot()).toBeUndefined();
  expect(client.intent("failed-cap-69").getSnapshot()).toMatchObject({ state: "failed" });
});
