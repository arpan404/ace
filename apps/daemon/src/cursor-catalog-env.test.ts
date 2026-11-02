import { afterEach, expect, test } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AccountService, openRegistry } from "@ace/accounts";
import { ModelCatalog, openModelStorage, type ModelInstance } from "@ace/models";
import { AccountManagement } from "./account-management.ts";
import { createManagedHome } from "./account-homes.ts";
import { cursorCatalogEnvironment } from "./cursor-catalog-env.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Restarts the daemon's account owner over `count` signed-in Cursor accounts and returns the
 * environment each account's SDK catalog worker would start with.
 */
async function cursorWorkerEnvironments(count: number) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "ace-cursor-catalog-")));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const registry = await openRegistry(join(dataDir, "accounts.sqlite"));
  cleanups.push(async () => registry.close());
  const homes: string[] = [];
  for (let index = 0; index < count; index++) {
    const instance = await createManagedHome(
      dataDir,
      `account-${randomUUID()}`,
      "cursor",
      `Cursor ${index}`,
    );
    await registry.register(instance);
    homes.push(instance.homeDir);
  }
  // The person started ace without a Cursor key, as the desktop app does.
  const launchEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/Users/person" };
  const discovered = new Map<string, ModelInstance>();
  const allDiscovered = Promise.withResolvers<void>();
  const catalog = new ModelCatalog({
    storage: openModelStorage(join(dataDir, "models.sqlite")),
    now: () => 100,
    deadline: () => () => {},
    discover: async (config) => {
      discovered.set(config.id, config);
      if (discovered.size === count) allDiscovered.resolve();
      return [];
    },
  });
  cleanups.push(() => catalog.close());
  const management = new AccountManagement({
    registry,
    accounts: new AccountService({ registry, env: launchEnv, now: () => 100, timeZone: "UTC" }),
    dataDir,
    env: launchEnv,
    now: () => 100,
    id: randomUUID,
    models: () => catalog,
    cursor: () => ({
      env: launchEnv,
      busy: () => false,
      fence: async () => {},
      rebind: async () => {},
      status: async () => "logged_in",
    }),
  });
  cleanups.push(() => management.close());
  await management.initialize();
  await allDiscovered.promise;
  return homes.map((home) => {
    const row = [...discovered.values()].find((config) => config.homeDir === home);
    if (!row) throw new Error("A signed-in Cursor account got no catalog worker");
    return {
      home,
      env: cursorCatalogEnvironment({ registry, launchEnv, isFenced: () => false }, row),
    };
  });
}

// Cursor's SDK takes CURSOR_API_KEY, even an empty one, over the account's saved login, and ace
// reads an empty key as "not configured". Each worker must reach its own saved login instead.
test("one signed-in Cursor account's catalog worker reads that account's saved login", async () => {
  const [account] = await cursorWorkerEnvironments(1);
  expect(account?.env.CURSOR_API_KEY).toBeUndefined();
  expect(account?.env.HOME).toBe(join(account?.home ?? "", "user"));
});

test("two signed-in Cursor accounts each keep their own saved login after a restart", async () => {
  const accounts = await cursorWorkerEnvironments(2);
  expect(new Set(accounts.map((account) => account.env.HOME)).size).toBe(2);
  for (const account of accounts) {
    expect(account.env.CURSOR_API_KEY).toBeUndefined();
    expect(account.env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(account.env.HOME).toBe(join(account.home, "user"));
  }
});
