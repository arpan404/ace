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

test("a full tab RPC queue refuses a new submission before allocating an ID and remount permits retry", async () => {
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
    let allocated = false;
    await expect(
      client.submitNew(input, () => {
        allocated = true;
      }),
    ).rejects.toMatchObject({
      code: "not_dispatched",
    });
    expect(allocated).toBe(false);
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
  expect(await remounted.submitNew(input, () => {})).toMatchObject({ ok: true });
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
  let commandId: string | undefined;
  const originalOptions = { timeoutMs: 100, admission: "fresh" };
  const receipt = z.object({
    t: z.literal("reply"),
    value: z.object({
      result: z.object({ commandId: z.string(), ok: z.literal(true) }),
    }),
  });
  faults.worker = (message, deliver) => {
    const parsed = receipt.safeParse(message);
    if (parsed.success && parsed.data.value.result.commandId === commandId) lost.resolve();
    else deliver(message);
  };
  const original = tab();
  await original.start();
  const input = { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) } as const;
  const waiting = original
    .submitNew(
      input,
      (id) => {
        commandId = id;
      },
      originalOptions,
    )
    .catch((error: unknown) => error);
  await lost.promise;
  await deleted.promise;
  if (!commandId) throw new Error("The new submission must allocate its own ID");
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
  expect(replay.intent(commandId).getSnapshot()).toBeUndefined();
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
    await expect(replay.command(input, originalOptions, commandId)).rejects.toMatchObject({
      code: "limit",
    });
    expect(replay.intent(commandId).getSnapshot()?.localFailure).toBeUndefined();
  } finally {
    controller.abort();
    await Promise.all(reads);
  }
});

test("a worker waits for the recording callback before an allocated command can reach the daemon", async () => {
  const { daemon, tab } = world();
  const scenario = new ScenarioPlayer(daemon, flakyCheckout());
  scenario.runUntilBlocked();
  const client = tab();
  await client.start();
  const recording = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const payload = { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) } as const;
  const result = client.submitNew(payload, async () => {
    recording.resolve();
    await release.promise;
  });
  await recording.promise;
  const before = daemon.snapshot({ kind: "threads" });
  expect(
    before?.kind === "threads" ? before.threads[scenario.threadId]?.archivedAt : undefined,
  ).toBeUndefined();
  release.resolve();
  expect(await result).toMatchObject({ ok: true });
  const after = daemon.snapshot({ kind: "threads" });
  expect(
    after?.kind === "threads" ? after.threads[scenario.threadId]?.archivedAt : undefined,
  ).toBeDefined();
});

test("a failed recording callback refuses the new worker command without daemon effects", async () => {
  const { daemon, tab } = world();
  const scenario = new ScenarioPlayer(daemon, flakyCheckout());
  scenario.runUntilBlocked();
  const client = tab();
  await client.start();
  await expect(
    client.submitNew(
      { type: "thread.archive", threadId: ThreadId.parse(scenario.threadId) },
      () => {
        throw new Error("Recording unavailable");
      },
    ),
  ).rejects.toMatchObject({ code: "not_dispatched" });
  const snapshot = daemon.snapshot({ kind: "threads" });
  expect(
    snapshot?.kind === "threads" ? snapshot.threads[scenario.threadId]?.archivedAt : undefined,
  ).toBeUndefined();
});
