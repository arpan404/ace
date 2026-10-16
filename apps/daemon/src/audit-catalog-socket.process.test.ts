import { expect, test } from "vitest";
import { ProviderStatuses } from "./provider-status.ts";
import { fixture } from "./socket-test-support.ts";
import { setImmediate } from "node:timers/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandLibrary } from "@ace/commands";
import { ServerMessage, type CatalogEntry } from "@ace/protocol";

test("an idle catalog subscription publishes nothing until a real file edit", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-idle-socket-")));
  const root = join(home, "workspace/.ace/prompts");
  await mkdir(root, { recursive: true });
  const file = join(root, "review.md");
  await writeFile(file, "---\ndescription: Original review\n---\nReview");
  const library = new CommandLibrary({
    aceHome: join(home, "ace"),
    instances: [],
    now: () => 0,
    context: () => ({ workspace: join(home, "workspace"), provider: "codex", instance: "codex" }),
    // Provider discovery is asynchronous I/O; the socket, discovery and SQLite are real.
    extras: async () => {
      await sleep(5);
      return [];
    },
  });
  const f = await fixture({ commands: library });
  try {
    await library.list("thread", "", 10);
    while ((await library.listCatalog("thread")).stale) await sleep(5);
    const client = await f.connect();
    await client.next();
    client.send({
      type: "catalog.list",
      requestId: "idle",
      threadId: f.thread.id,
      subscribe: true,
      query: "",
      limit: 128,
    });
    expect(await client.next()).toMatchObject({ type: "catalog.list.result", stale: false });
    const pushes: CatalogEntry[][] = [];
    client.socket.on("message", (data) => {
      const message = ServerMessage.parse(JSON.parse(data.toString()));
      if (message.type === "catalog.changed") pushes.push(message.entries);
    });
    await sleep(1100);
    expect(pushes).toEqual([]);
    await writeFile(file, "---\ndescription: Changed review\n---\nReview changed");
    await expect
      .poll(() => pushes.some((entries) => entries.some((e) => e.description === "Changed review")))
      .toBe(true);
  } finally {
    await f.close();
    await library.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("replacing a pending catalog subscription still allows the replacement to unsubscribe", async () => {
  const held = Promise.withResolvers<{ entries: []; stale: boolean }>();
  const reading = Promise.withResolvers<void>();
  const changes = new Set<() => void>();
  let first = true;
  let stale = false;
  const library = new CommandLibrary({
    aceHome: process.env.HOME ?? "/unused",
    instances: [],
    now: () => 0,
    context: () => ({ workspace: "/unused", provider: "codex", instance: "codex" }),
  });
  library.listCatalog = async () => {
    if (first) {
      first = false;
      reading.resolve();
      return held.promise;
    }
    return { entries: [], stale };
  };
  library.subscribeCatalog = (callback) => {
    changes.add(callback);
    return () => {
      changes.delete(callback);
    };
  };
  const f = await fixture({ commands: library });
  try {
    const client = await f.connect();
    await client.next();
    const request = {
      type: "catalog.list" as const,
      requestId: "replaced",
      threadId: f.thread.id,
      subscribe: true,
      query: "",
      limit: 10,
    };
    client.send(request);
    await reading.promise;
    client.send(request);
    expect(await client.next()).toMatchObject({
      type: "catalog.list.result",
      requestId: "replaced",
    });
    held.resolve({ entries: [], stale: false });
    await setImmediate();
    client.send({ type: "ping" });
    expect((await client.next()).type).toBe("pong");
    client.send({ type: "catalog.unsubscribe", requestId: "replaced" });
    client.send({ type: "ping" });
    expect((await client.next()).type).toBe("pong");
    stale = true;
    for (const change of changes) change();
    await setImmediate();
    client.send({ type: "ping" });
    expect((await client.next()).type).toBe("pong");
  } finally {
    held.resolve({ entries: [], stale: false });
    await f.close();
    await library.close();
  }
});

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
