import { expect, test } from "vitest";
import { ProviderStatuses } from "./provider-status.ts";
import { fixture } from "./socket-test-support.ts";

// Hold metadata at its provider boundary; the socket and server remain real.
test("a slow provider refresh cannot hold a later ping behind it", async () => {
  const held = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const statuses = new ProviderStatuses(
    {
      env: { PATH: "", HOME: process.env.HOME },
      cursorSdk: async () => {
        started.resolve();
        await held.promise;
        return { installed: false, auth: "unknown", loginHint: "" };
      },
    },
    { now: () => 1000, schedule: () => () => {} },
  );
  const f = await fixture({ providerStatuses: statuses });
  try {
    const client = await f.connect();
    await client.next();
    await started.promise;
    client.send({ type: "providers.request", requestId: "slow", operation: "refresh" });
    client.send({ type: "ping" });
    expect((await client.next()).type).toBe("pong");
    held.resolve();
    expect(await client.next()).toMatchObject({
      type: "providers.result",
      requestId: "slow",
      result: { ok: true },
    });
  } finally {
    held.resolve();
    await f.close();
    await statuses.close();
  }
});

test("a slow catalog read lets later socket reads proceed and reports failed subscription pushes", async () => {
  const held = Promise.withResolvers<{ entries: []; stale: boolean }>();
  const reading = Promise.withResolvers<void>();
  let changed: (() => void) | undefined;
  let pushFails = false;
  const { CommandLibrary } = await import("@ace/commands");
  const library = new CommandLibrary({
    aceHome: process.env.HOME ?? "/unused",
    instances: [],
    now: () => 0,
    context: () => ({ workspace: "/unused", provider: "codex", instance: "codex" }),
  });
  library.listCatalog = async () => {
    reading.resolve();
    if (pushFails) throw new Error("Read failed");
    return held.promise;
  };
  library.subscribeCatalog = (callback) => {
    changed = callback;
    return () => {
      changed = undefined;
    };
  };
  const f = await fixture({ commands: library });
  try {
    const client = await f.connect();
    await client.next();
    client.send({
      type: "catalog.list",
      requestId: "slow-catalog",
      threadId: f.thread.id,
      subscribe: true,
      query: "",
      limit: 10,
    });
    await reading.promise;
    client.send({ type: "ping" });
    expect((await client.next()).type).toBe("pong");
    held.resolve({ entries: [], stale: false });
    expect(await client.next()).toMatchObject({
      type: "catalog.list.result",
      requestId: "slow-catalog",
    });
    pushFails = true;
    changed?.();
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "catalog_unavailable",
      requestId: "slow-catalog",
    });
    client.send({ type: "ping" });
    expect((await client.next()).type).toBe("pong");
  } finally {
    held.resolve({ entries: [], stale: false });
    await f.close();
    await library.close();
  }
});

test("an account read failure is logged and returned without closing the socket", async () => {
  const { AccountService, openRegistry } = await import("@ace/accounts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "ace-account-error-"));
  const registry = await openRegistry(join(home, "accounts.sqlite"));
  const accounts = new AccountService({ registry, env: {}, now: () => 0, timeZone: "UTC" });
  registry.close();
  const logged = Promise.withResolvers<unknown>();
  const f = await fixture({ accounts, log: (error) => logged.resolve(error) });
  try {
    const client = await f.connect();
    await client.next();
    client.send({ type: "accounts.list", requestId: "bad-account-read" });
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "accounts_failed",
      requestId: "bad-account-read",
    });
    expect(await logged.promise).toBeInstanceOf(Error);
    client.send({ type: "ping" });
    expect((await client.next()).type).toBe("pong");
  } finally {
    await f.close();
    await rm(home, { recursive: true, force: true });
  }
});
