import { ThreadId } from "@ace/protocol";
import { defaultLimits } from "@ace/client";
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
    await expect(client.command(input, {}, "fresh-capacity")).rejects.toMatchObject({
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
