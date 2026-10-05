import { afterEach, expect, test, vi } from "vitest";
import { CommandPayload, ThreadId } from "@ace/protocol";
import { z } from "zod";
import { longHistory, ScenarioPlayer } from "@ace/fake-daemon";
import { RemoteClient } from "./index.ts";
import { cleanups, timers, world } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("subscriber-free command and enqueue sends retain only a bounded newest cache", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, longHistory(1));
  script.runUntilBlocked();
  const remote = tab("local", { unwatchedIntents: 2 });
  await remote.start();
  const lease = remote.thread(script.threadId);
  for (let i = 0; i < 20; i++) {
    const payload = CommandPayload.parse({
      type: "thread.send",
      threadId: ThreadId.parse(script.threadId),
      input: [{ type: "text", text: "x".repeat(32 * 1024) }],
    });
    if (i % 2) await remote.enqueue(payload, `bounded-${i}`);
    else expect(await remote.command(payload, {}, `bounded-${i}`)).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(
        remote
          .pendingSends()
          .getSnapshot()
          .find((entry) => entry.commandId === `bounded-${i}`)?.state,
      ).toBe("delivered"),
    );
    expect(remote.pendingSends().getSnapshot().length).toBeLessThanOrEqual(2);
  }
  expect(remote.intent("bounded-0").getSnapshot()).toBeUndefined();
  expect(remote.intent("bounded-18").getSnapshot()).toMatchObject({ state: "acked" });
  expect(
    (await remote.itemsPage({ threadId: script.threadId, limit: 100 })).items.filter((item) =>
      item.id.startsWith("input:bounded-"),
    ).length,
  ).toBe(20);
  lease.release();
});

test("oversized remote drafts never publish full payloads through either send API", async () => {
  const { tab } = world();
  const remote = tab();
  await remote.start();
  let heard = 0;
  const selection = remote.pendingSends();
  const stop = selection.subscribe(() => heard++);
  // Let the initial reset arrive before counting draft changes.
  await remote.itemsPage({ threadId: "absent", limit: 1 }).catch(() => {});
  const before = heard;
  for (let i = 0; i < 20; i++) {
    const payload = CommandPayload.parse({
      type: "thread.send",
      threadId: "absent",
      input: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
    });
    await expect(remote.command(payload, {}, `huge-command-${i}`)).rejects.toMatchObject({
      code: "limit",
    });
    await expect(remote.enqueue(payload, `huge-enqueue-${i}`)).rejects.toMatchObject({
      code: "limit",
    });
  }
  expect(heard).toBe(before);
  expect(selection.getSnapshot()).toEqual([]);
  stop();
});

test("hidden tabs buffer pending changes and resume with the latest bounded snapshot", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, longHistory(1));
  script.runUntilBlocked();
  const hidden = tab();
  const sender = tab();
  await Promise.all([hidden.start(), sender.start()]);
  const selection = hidden.pendingSends(script.threadId);
  const stop = selection.subscribe(() => {});
  hidden.show(false);
  await hidden.itemsPage({ threadId: script.threadId, limit: 1 });
  const messages = () =>
    hidden.traffic.filter(
      (value) => z.object({ t: z.literal("pendingSends") }).safeParse(value).success,
    ).length;
  const before = messages();
  const snapshot = selection.getSnapshot();
  for (let i = 0; i < 270; i++)
    expect(
      await sender.command(
        {
          type: "thread.send",
          threadId: ThreadId.parse(script.threadId),
          input: [{ type: "text", text: `Hidden ${i}` }],
          delivery: "steer",
        },
        {},
        `hidden-${i}`,
      ),
    ).toMatchObject({ ok: true });
  await sender.itemsPage({ threadId: script.threadId, limit: 1 });
  expect(messages()).toBe(before);
  expect(selection.getSnapshot()).toBe(snapshot);
  hidden.show(true);
  await vi.waitFor(() =>
    expect(selection.getSnapshot().some((entry) => entry.commandId === "hidden-269")).toBe(true),
  );
  expect(selection.getSnapshot().some((entry) => entry.commandId === "hidden-0")).toBe(false);
  expect(selection.getSnapshot().length).toBeLessThanOrEqual(256);
  stop();
});

test("injected tab command IDs reach admission items unchanged", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, longHistory(1));
  script.runUntilBlocked();
  const remote = tab("local", { id: () => "injected-id" });
  await remote.start();
  const result = await remote.command({
    type: "thread.send",
    threadId: ThreadId.parse(script.threadId),
    input: [{ type: "text", text: "Injected" }],
  });
  expect(result.commandId).toBe("injected-id");
  expect((await remote.itemsPage({ threadId: script.threadId, limit: 1 })).items[0]?.id).toBe(
    "input:injected-id",
  );
});

test("a remote without an injected or worker-assigned ID generator refuses allocation", async () => {
  const { port1, port2 } = new MessageChannel();
  const remote = new RemoteClient(port2, {}, { scheduler: timers });
  cleanups.push(async () => {
    await remote.close();
    port1.close();
  });
  // Consume the unattached start promise so close does not produce an unhandled rejection.
  void remote.start().catch(() => {});
  expect(() =>
    remote.command({
      type: "thread.send",
      threadId: ThreadId.parse("absent"),
      input: [{ type: "text", text: "No ambient randomness" }],
    }),
  ).toThrow(/generator/);
});

test("unwatched remote input caches evict by bytes before their count cap", async () => {
  const { daemon, tab } = world();
  const script = new ScenarioPlayer(daemon, longHistory(1));
  script.runUntilBlocked();
  const remote = tab();
  await remote.start();
  for (let i = 0; i < 40; i++)
    expect(
      await remote.command(
        {
          type: "thread.send",
          threadId: ThreadId.parse(script.threadId),
          input: [{ type: "text", text: "x".repeat(240 * 1024) }],
        },
        {},
        `bytes-${i}`,
      ),
    ).toMatchObject({ ok: true });
  const retained = Array.from({ length: 40 }, (_, i) =>
    remote.intent(`bytes-${i}`).getSnapshot(),
  ).filter(Boolean);
  expect(new TextEncoder().encode(JSON.stringify(retained)).byteLength).toBeLessThanOrEqual(
    8 * 1024 * 1024,
  );
  expect(remote.intent("bytes-0").getSnapshot()).toBeUndefined();
  expect(remote.intent("bytes-39").getSnapshot()).toMatchObject({ state: "acked" });
  expect(
    new TextEncoder().encode(JSON.stringify(remote.pendingSends().getSnapshot())).byteLength,
  ).toBeLessThanOrEqual(8 * 1024 * 1024);
});

test("pending frames forward only changed IDs once per frame", async () => {
  const { daemon, tab, advance } = world(undefined, { frameMs: 100 });
  const script = new ScenarioPlayer(daemon, longHistory(1));
  script.runUntilBlocked();
  const sender = tab();
  const receiver = tab();
  await Promise.all([sender.start(), receiver.start()]);
  sender.networkOnline(false);
  await vi.waitFor(() => expect(sender.state).toBe("offline"));
  const selection = receiver.pendingSends(script.threadId);
  const stop = selection.subscribe(() => {});
  const enqueue = (i: number) =>
    sender.enqueue(
      {
        type: "thread.send",
        threadId: ThreadId.parse(script.threadId),
        input: [{ type: "text", text: `Frame ${i}` }],
      },
      `frame-${i}`,
    );
  for (let i = 0; i < 3; i++) await enqueue(i);
  advance(100);
  await vi.waitFor(() => expect(selection.getSnapshot()).toHaveLength(3));
  const packets = () =>
    receiver.traffic.flatMap((value) => {
      const parsed = z
        .object({
          t: z.literal("pendingSends"),
          entries: z.array(z.object({ commandId: z.string() })),
        })
        .safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  const before = packets().length;
  await enqueue(3);
  await enqueue(4);
  expect(packets()).toHaveLength(before);
  advance(100);
  await vi.waitFor(() => expect(selection.getSnapshot()).toHaveLength(5));
  expect(packets()).toHaveLength(before + 1);
  expect(
    packets()
      .at(-1)
      ?.entries.map((entry) => entry.commandId),
  ).toEqual(["frame-3", "frame-4"]);
  stop();
});
