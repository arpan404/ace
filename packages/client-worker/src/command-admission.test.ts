import { ThreadId } from "@ace/protocol";
import { defaultLimits, type Storage } from "@ace/client";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { flakyCheckout, ScenarioPlayer } from "@ace/fake-daemon";
import { afterEach, expect, test } from "vitest";
import { cleanups, world } from "./worker-test-support.ts";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("a full tab RPC queue refuses a fresh command as unsent and the same ID can be retried after capacity frees", async () => {
  const { daemon, tab, faults } = world();
  const scenario = new ScenarioPlayer(daemon, flakyCheckout());
  scenario.runUntilBlocked();
  const client = tab();
  await client.start();
  const controller = new AbortController();
  faults.incoming = (message, text, deliver) => {
    if (message.type !== "items.page") deliver(text);
  };
  const reads = Array.from({ length: defaultLimits.requests }, () =>
    client
      .itemsPage({ threadId: scenario.threadId, limit: 1 }, { signal: controller.signal })
      .catch((error: unknown) => error),
  );
  const input = { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) } as const;
  try {
    await expect(
      client.command(input, { admission: "fresh" }, "fresh-capacity"),
    ).rejects.toMatchObject({
      code: "not_dispatched",
    });
    expect(client.intent("fresh-capacity").getSnapshot()).toBeUndefined();
    const before = daemon.snapshot({ kind: "threads" });
    expect(
      before?.kind === "threads" ? before.threads[scenario.threadId]?.archivedAt : undefined,
    ).toBeUndefined();
  } finally {
    controller.abort();
    await Promise.all(reads);
  }
  faults.incoming = (_message, text, deliver) => deliver(text);
  await client.itemsPage({ threadId: scenario.threadId, limit: 1 });
  await client.close();
  const remounted = tab();
  await remounted.start();
  expect(remounted.intent("fresh-capacity").getSnapshot()).toBeUndefined();
  expect(await remounted.command(input, {}, "fresh-capacity")).toMatchObject({ ok: true });
  const after = daemon.snapshot({ kind: "threads" });
  expect(
    after?.kind === "threads" ? after.threads[scenario.threadId]?.archivedAt : undefined,
  ).toBeDefined();
});

test("a newly attached tab at capacity cannot declare another tab's admitted command unsent", async () => {
  const { daemon, tab, faults } = world();
  const scenario = new ScenarioPlayer(daemon, flakyCheckout());
  scenario.runUntilBlocked();
  let deliverReceipt: (() => void) | undefined;
  faults.incoming = (message, text, deliver) => {
    if (message.type === "commandResult" && message.commandId === "already-admitted")
      deliverReceipt = () => deliver(text);
    else if (message.type !== "items.page") deliver(text);
  };
  const originalTab = tab();
  await originalTab.start();
  const input = { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) } as const;
  const original = originalTab.command(input, {}, "already-admitted");
  await faults.wait(
    (message) => message.type === "commandResult" && message.commandId === "already-admitted",
  );
  const reopened = tab();
  await reopened.start();
  expect(reopened.intent("already-admitted").getSnapshot()).toBeUndefined();
  const controller = new AbortController();
  const reads = Array.from({ length: defaultLimits.requests }, () =>
    reopened
      .itemsPage({ threadId: scenario.threadId, limit: 1 }, { signal: controller.signal })
      .catch((error: unknown) => error),
  );
  try {
    await expect(reopened.command(input, {}, "already-admitted")).rejects.toMatchObject({
      code: "limit",
    });
    deliverReceipt?.();
    expect(await original).toMatchObject({ ok: true });
  } finally {
    controller.abort();
    deliverReceipt?.();
    await Promise.all(reads);
  }
});

test("a lost tab reply followed by worker restart keeps replay uncertain after the acknowledged intent was deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-worker-receipt-"));
  const path = join(directory, "outbox.json");
  await writeFile(path, "[]");
  const deleted = Promise.withResolvers<void>();
  const outbox: Storage = {
    load: () => readFile(path, "utf8"),
    async save(value) {
      const temporary = join(directory, "outbox.tmp");
      await writeFile(temporary, value);
      await rename(temporary, path);
      if (value === "[]") deleted.resolve();
    },
  };
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const environment = world(undefined, {}, undefined, outbox);
  const { daemon, tab, faults, advance } = environment;
  const scenario = new ScenarioPlayer(daemon, flakyCheckout());
  scenario.runUntilBlocked();
  const lost = Promise.withResolvers<void>();
  const receipt = z.object({
    t: z.literal("reply"),
    value: z.object({
      result: z.object({ commandId: z.literal("lost-tab-reply"), ok: z.literal(true) }),
    }),
  });
  faults.worker = (message, deliver) => {
    if (receipt.safeParse(message).success) lost.resolve();
    else deliver(message);
  };
  const original = tab();
  await original.start();
  const input = { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) } as const;
  const waiting = original
    .command(input, { admission: "fresh" }, "lost-tab-reply")
    .catch((error: unknown) => error);
  await lost.promise;
  await deleted.promise;
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
  const accepted = daemon.snapshot({ kind: "threads" });
  expect(
    accepted?.kind === "threads" ? accepted.threads[scenario.threadId]?.archivedAt : undefined,
  ).toBeDefined();
  await original.close();
  await original.left;
  await waiting;
  advance(1000);
  environment.restartWorker();
  faults.worker = (message, deliver) => deliver(message);
  const replay = tab();
  await replay.start();
  expect(replay.intent("lost-tab-reply").getSnapshot()).toBeUndefined();
  faults.incoming = (message, text, deliver) => {
    if (message.type !== "items.page") deliver(text);
  };
  const controller = new AbortController();
  const reads = Array.from({ length: defaultLimits.requests }, () =>
    replay
      .itemsPage({ threadId: scenario.threadId, limit: 1 }, { signal: controller.signal })
      .catch((error: unknown) => error),
  );
  try {
    await expect(replay.command(input, {}, "lost-tab-reply")).rejects.toMatchObject({
      code: "limit",
    });
    expect(replay.intent("lost-tab-reply").getSnapshot()?.localFailure).toBeUndefined();
  } finally {
    controller.abort();
    await Promise.all(reads);
  }
});

test("a legacy worker's missing-intent unsent inference cannot release a replayed ID", async () => {
  const { daemon, tab, faults } = world();
  const scenario = new ScenarioPlayer(daemon, flakyCheckout());
  scenario.runUntilBlocked();
  const client = tab();
  await client.start();
  const evidence = z.object({ t: z.literal("command.admission"), check: z.number() });
  faults.worker = (message, deliver) => {
    const parsed = evidence.safeParse(message);
    deliver(parsed.success ? { ...parsed.data, outcome: "unsent" } : message);
  };
  faults.incoming = (message, text, deliver) => {
    if (message.type !== "items.page") deliver(text);
  };
  const controller = new AbortController();
  const reads = Array.from({ length: defaultLimits.requests }, () =>
    client
      .itemsPage({ threadId: scenario.threadId, limit: 1 }, { signal: controller.signal })
      .catch((error: unknown) => error),
  );
  try {
    await expect(
      client.command(
        { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) },
        {},
        "restored-without-history",
      ),
    ).rejects.toMatchObject({ code: "limit" });
  } finally {
    controller.abort();
    await Promise.all(reads);
  }
});
