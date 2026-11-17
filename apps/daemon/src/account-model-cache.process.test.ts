import { expect, test, vi } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ModelCatalog, openModelStorage, normalizeCodex, createModelDiscovery } from "@ace/models";
import { rm } from "node:fs/promises";
import { openRegistryIndex } from "@ace/accounts";
import { AccountManagement } from "./account-management.ts";
import { harness } from "./account-management-test-support.ts";

test("validated account caches are available at startup while model discovery is still pending", async () => {
  const f = await harness();
  let catalog: ModelCatalog | undefined;
  let management: AccountManagement | undefined;
  const replacement = Promise.withResolvers<void>();
  try {
    const account = await f.add();
    await f.flow(account.id, "login");
    const cached = f.models.list({ instance: account.id }).models[0];
    if (!cached) throw new Error("Login did not persist its model catalog");
    await f.models.close();
    const restarted = new ModelCatalog({
      storage: openModelStorage(join(f.dataDir, "models.sqlite")),
      now: () => 100,
      deadline: () => () => {},
      discover: (config, signal) =>
        new Promise((resolve, reject) => {
          const abort = () => reject(new Error("cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          void replacement.promise
            .then(() => {
              signal.removeEventListener("abort", abort);
              resolve(
                normalizeCodex(
                  {
                    data: [
                      {
                        id: "new",
                        model: "gpt-6.2-sol",
                        displayName: "GPT-6.2 Sol",
                        isDefault: false,
                        supportedReasoningEfforts: [],
                        defaultReasoningEffort: "high",
                      },
                    ],
                  },
                  config,
                ),
              );
            })
            .catch(reject);
        }),
    });
    catalog = restarted;
    management = new AccountManagement({
      registry: f.registry,
      accounts: f.accounts,
      dataDir: f.dataDir,
      env: f.env,
      now: () => 100,
      id: randomUUID,
      models: () => restarted,
    });
    await management.initialize();
    expect(restarted.list({ instance: account.id })).toMatchObject({
      models: [{ id: cached.id, source: { kind: "account", label: "Work" } }],
      instances: [{ status: "refreshing" }],
    });
    replacement.resolve();
    await management.close();
    management = undefined;
    expect(restarted.resolveCached({ role: "thread", instance: account.id })).toMatchObject({
      ok: true,
      model: { id: "gpt-6.2-sol", isDefault: true },
    });
  } finally {
    replacement.resolve();
    await management?.close();
    await catalog?.close();
    await f.close();
  }
});

test("a missing CLI at account restoration keeps the last good models beside a discovery error", async () => {
  const f = await harness();
  let catalog: ModelCatalog | undefined;
  let management: AccountManagement | undefined;
  try {
    const account = await f.add();
    await f.flow(account.id, "login");
    const cached = f.models.list({ instance: account.id }).models[0];
    if (!cached) throw new Error("Login did not persist its model catalog");
    await f.models.close();
    await rm(join(f.bin, "codex"));
    const restarted = new ModelCatalog({
      storage: openModelStorage(join(f.dataDir, "models.sqlite")),
      now: () => 100,
      deadline: () => () => {},
      discover: createModelDiscovery(),
    });
    catalog = restarted;
    management = new AccountManagement({
      registry: f.registry,
      accounts: f.accounts,
      dataDir: f.dataDir,
      env: f.env,
      now: () => 100,
      id: randomUUID,
      models: () => restarted,
    });
    await management.initialize();
    expect(restarted.list({ instance: account.id }).models.map((model) => model.id)).toEqual([
      cached.id,
    ]);
    await management.close();
    management = undefined;
    expect(restarted.list({ instance: account.id })).toMatchObject({
      models: [{ id: cached.id }],
      instances: [{ status: "stale", errorDetail: { code: "discovery_failed" } }],
    });
  } finally {
    await management?.close();
    await catalog?.close();
    await f.close();
  }
});

test("each managed account is restored as its own folder answers, not after every other account's", async () => {
  const f = await harness();
  let catalog: ModelCatalog | undefined;
  let management: AccountManagement | undefined;
  let registry: Awaited<ReturnType<typeof openRegistryIndex>> | undefined;
  const answer = Promise.withResolvers<void>();
  try {
    const added = [await f.add(), await f.add()].toSorted((a, b) => a.id.localeCompare(b.id));
    const [working, silent] = added;
    if (!working || !silent) throw new Error("Accounts were not added");
    for (const account of added) await f.flow(account.id, "login");
    await f.management.close();
    // Restart: the folder checked last hasn't answered, and its patience never runs out.
    registry = await openRegistryIndex(join(f.dataDir, "accounts.sqlite"), undefined, f.dataDir, {
      check: (instance, next) =>
        instance.id === silent.id ? answer.promise.then(() => next(instance)) : next(instance),
      after: () => () => {},
    });
    await registry.checked(working.id);
    const restarted = new ModelCatalog({
      storage: openModelStorage(join(f.dataDir, "models-restarted.sqlite")),
      now: () => 100,
      deadline: () => () => {},
      discover: async () => {
        throw new Error("offline");
      },
    });
    catalog = restarted;
    management = new AccountManagement({
      registry,
      accounts: f.accounts,
      dataDir: f.dataDir,
      env: f.env,
      now: () => 100,
      id: randomUUID,
      models: () => restarted,
    });
    const initialized = management.initialize();
    await vi.waitFor(() =>
      expect(restarted.list({ instance: working.id }).instances).toHaveLength(1),
    );
    expect(restarted.list({ instance: silent.id }).instances).toHaveLength(0);
    await initialized;
    answer.resolve();
    await vi.waitFor(() =>
      expect(restarted.list({ instance: silent.id }).instances).toHaveLength(1),
    );
  } finally {
    answer.resolve();
    await management?.close();
    await catalog?.close();
    registry?.close();
    await f.close();
  }
});
