import { z } from "zod";
import { expect, test } from "vitest";
import { lstat, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { AccountManagement } from "./account-management.ts";
import { runAccountsCommand, AccountService } from "@ace/accounts";
import { randomUUID } from "node:crypto";
import { fixture } from "./socket-test-support.ts";
import { openRegistry } from "@ace/accounts";
import { probeOutput } from "@ace/provider-kit/process";
import { createModelDiscovery } from "@ace/models";
import { harness, poll } from "./account-management-test-support.ts";

// Reproductions are written before the fixes; execution is deferred to merge.
test("restart refuses a managed home replaced with an outside symlink before any discovery", async () => {
  const f = await harness();
  try {
    const account = await f.add();
    const home = join(f.dataDir, "account-homes", account.id);
    await rm(home, { recursive: true });
    await symlink(f.normalHome, home);
    await expect(openRegistry(join(f.dataDir, "accounts.sqlite"))).rejects.toThrow();
    await expect(f.management.initialize()).rejects.toThrow();
    await expect(readFile(join(f.dataDir, "fixture-invocations.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(f.normalHome, "untouched"), "utf8")).toBe("normal CLI home");
  } finally {
    await f.close();
  }
});

test("model refresh refuses a replaced home after successful login", async () => {
  const f = await harness();
  try {
    const account = await f.add();
    await f.flow(account.id, "login");
    await poll(() => f.accounts.isChangingAccount(account.id)).toBe(false);
    const home = join(f.dataDir, "account-homes", account.id);
    const before = await readFile(join(f.dataDir, "fixture-invocations.jsonl"), "utf8");
    await rm(home, { recursive: true });
    await symlink(f.normalHome, home);
    expect(
      await f.request(f.owner, {
        type: "models.refresh",
        requestId: f.rid(),
        filter: { instance: account.id },
      }),
    ).toMatchObject({
      type: "models.result",
      result: { instances: [{ error: "discovery_failed" }], models: [] },
    });
    expect(await readFile(join(f.dataDir, "fixture-invocations.jsonl"), "utf8")).toBe(before);
  } finally {
    await f.close();
  }
});

test("disconnect cancels startup and retains the account until status discovery cleanup settles", async () => {
  const cleanup = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const f = await harness(false, {
    discovery: {
      probe: async (command, args, options) => {
        const result = probeOutput(command, args, options);
        if (args.join(" ") !== "login status") return result;
        options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        try {
          return await result;
        } finally {
          await cleanup.promise;
        }
      },
    },
  });
  try {
    const account = await f.add();
    const home = join(f.dataDir, "account-homes", account.id);
    await writeFile(join(home, "fixture-hold-status"), "hold");
    const auth = await f.request(f.owner, {
      type: "accounts.login",
      requestId: f.rid(),
      instanceId: account.id,
    });
    if (auth.type !== "accounts.auth") throw new Error("Missing terminal");
    f.owner.send({
      type: "terminal.request",
      requestId: f.rid(),
      operation: {
        op: "subscribe",
        terminalId: auth.terminalId,
        subscriptionId: "starting",
        fromOffset: 0,
      },
    });
    // Subscribe acknowledges after startup; disconnect while this request is still pending.
    await poll(async () => {
      try {
        return (await lstat(join(home, "fixture-status-pid"))).isFile();
      } catch {
        return false;
      }
    }).toBe(true);
    const other = await f.connect();
    await other.next();
    await f.owner.close();
    await aborted.promise;
    await setImmediate();
    expect(
      await f.request(other, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "error", code: "accounts_failed" });
    expect((await lstat(home)).isDirectory()).toBe(true);
    cleanup.resolve();
    await poll(() => f.accounts.isChangingAccount(account.id)).toBe(false);
    const invocations = await readFile(join(f.dataDir, "fixture-invocations.jsonl"), "utf8");
    expect(
      invocations
        .split("\n")
        .filter(Boolean)
        .map((line) => z.object({ args: z.array(z.string()) }).parse(JSON.parse(line)).args),
    ).not.toContainEqual(["login"]);
    expect(
      await f.request(other, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "accounts.changed", account: null });
  } finally {
    cleanup.resolve();
    await f.close();
  }
});

test("a transient catalog deletion failure cannot release a home before metadata cleanup on retry", async () => {
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const discovery = createModelDiscovery();
  let hold = false;
  let fail = false;
  const f = await harness(false, {
    discover: async (instance, signal) => {
      if (!hold) return discovery(instance, signal);
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      try {
        return await discovery(instance, signal);
      } finally {
        await cleanup.promise;
      }
    },
    storage: (storage) => ({
      ...storage,
      load: () => storage.load(),
      replace: (entry) => storage.replace(entry),
      close: () => storage.close(),
      remove: (id) => {
        if (fail) {
          fail = false;
          failed.resolve();
          throw new Error("Transient storage failure");
        }
        return storage.remove(id);
      },
    }),
  });
  try {
    const account = await f.add();
    const home = join(f.dataDir, "account-homes", account.id);
    await f.flow(account.id, "login");
    await poll(() => f.accounts.isChangingAccount(account.id)).toBe(false);
    hold = true;
    await writeFile(join(home, "fixture-hold-model"), "hold");
    f.owner.send({ type: "models.refresh", requestId: f.rid(), filter: { instance: account.id } });
    await poll(async () => {
      try {
        return (await lstat(join(home, "fixture-model-pid"))).isFile();
      } catch {
        return false;
      }
    }).toBe(true);
    const other = await f.connect();
    await other.next();
    fail = true;
    const removal = f.request(f.owner, {
      type: "accounts.remove",
      requestId: f.rid(),
      instanceId: account.id,
      deleteHome: true,
    });
    await failed.promise;
    await aborted.promise;
    await setImmediate();
    expect(
      await f.request(other, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "error", code: "accounts_failed" });
    expect((await lstat(home)).isDirectory()).toBe(true);
    cleanup.resolve();
    expect(await removal).toMatchObject({ type: "error", code: "accounts_failed" });
    expect(
      await f.request(other, {
        type: "accounts.remove",
        requestId: f.rid(),
        instanceId: account.id,
        deleteHome: true,
      }),
    ).toMatchObject({ type: "accounts.changed", account: null });
    await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    cleanup.resolve();
    await f.close();
  }
});

test("restart restores safe sign-in status and the selected account's model catalog", async () => {
  const f = await harness();
  const account = await f.add();
  await f.flow(account.id, "login");
  await poll(() => f.accounts.isChangingAccount(account.id)).toBe(false);
  const registry = await openRegistry(join(f.dataDir, "accounts.sqlite"));
  const accounts = new AccountService({ registry, env: f.env, now: () => 100, timeZone: "UTC" });
  const management = new AccountManagement({
    registry,
    accounts,
    dataDir: f.dataDir,
    env: f.env,
    now: () => 100,
    id: randomUUID,
    models: () => f.models,
  });
  await management.initialize();
  const socket = await fixture({ accounts, accountManagement: management, models: f.models });
  try {
    const client = await socket.connect();
    await client.next();
    expect(
      await f.request(client, {
        type: "accounts.status",
        requestId: f.rid(),
        instanceId: account.id,
      }),
    ).toMatchObject({ account: { quota: { auth: "logged_in" } } });
    expect(
      await f.request(client, {
        type: "models.list",
        requestId: f.rid(),
        options: { instance: account.id, offset: 0, limit: 10 },
      }),
    ).toMatchObject({ result: { models: [{ nativeModelId: "fixture-account-model" }] } });
  } finally {
    await socket.close();
    await management.close();
    registry.close();
    await f.close();
  }
});

test("a custom registry database keeps the injected daemon data root for managed homes", async () => {
  const f = await harness();
  try {
    const account = await f.add();
    const database = join(f.root, "alternate-accounts.sqlite");
    await copyFile(join(f.dataDir, "accounts.sqlite"), database);
    let output = "";
    await runAccountsCommand(["accounts", "list"], {
      env: { ...f.env, ACE_HOME: f.dataDir, ACE_ACCOUNTS_DB: database },
      write: (text) => {
        output += text;
      },
    });
    const summaries = z.array(z.object({ id: z.string() })).parse(JSON.parse(output));
    expect(summaries.map((summary) => summary.id)).toContain(account.id);
    await rm(join(f.dataDir, "account-homes", account.id), { recursive: true });
    await symlink(f.normalHome, join(f.dataDir, "account-homes", account.id));
    await expect(
      runAccountsCommand(["accounts", "status", account.id], {
        env: { ...f.env, ACE_HOME: f.dataDir, ACE_ACCOUNTS_DB: database },
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
