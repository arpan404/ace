import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage, type CatalogStorage } from "./index.ts";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

function entry(id: string, model = "cached") {
  const config = instance("codex", id);
  return {
    provider: config.provider,
    instance: config.id,
    revision: config.loginRevision,
    refreshedAt: 1000,
    models: normalizeCodex(codexPayload(model), config),
  };
}

async function usingStorage(path: string, use: (storage: CatalogStorage) => Promise<void>) {
  const storage = openModelStorage(path);
  try {
    await use(storage);
  } finally {
    await storage.close();
  }
}

async function usingWorkspace(use: (path: string) => Promise<void>) {
  const work = await workspace();
  try {
    await use(join(work.path, "models.sqlite"));
  } finally {
    await work.close();
  }
}

test("durable capacity rejects new accounts but permits updates and reuse after removal", async () => {
  await usingWorkspace(async (path) => {
    await usingStorage(path, async (storage) => {
      for (let index = 0; index < 64; index++) await storage.replace(entry(`account-${index}`));
      await storage.replace(entry("account-0", "updated"));
      await expect(Promise.resolve(storage.replace(entry("replacement")))).rejects.toThrow(
        "persistence",
      );
    });
    await usingStorage(path, async (storage) => {
      const loaded = storage.load();
      expect(loaded).toHaveLength(64);
      expect(loaded.find((row) => row.instance === "account-0")?.models[0]?.id).toBe("updated");
      await storage.remove("account-0");
      await storage.replace(entry("replacement"));
    });
    await usingStorage(path, async (storage) => {
      const loaded = storage.load();
      expect(loaded).toHaveLength(64);
      expect(loaded.some((row) => row.instance === "account-0")).toBe(false);
      expect(loaded.find((row) => row.instance === "replacement")?.models[0]?.id).toBe("cached");
    });
  });
});

test.each(["eviction", "explicit removal"])(
  "failed %s cannot overflow durable capacity or make the catalog unusable after restart",
  async (removal) => {
    await usingWorkspace(async (path) => {
      const configs = Array.from({ length: 64 }, (_, index) =>
        instance("codex", `account-${index}`),
      );
      await usingStorage(path, async (storage) => {
        for (const config of configs) await storage.replace(entry(config.id));
      });
      const clock = new Clock();
      let model = "cached";
      const options = {
        discover: async (config: ReturnType<typeof instance>) =>
          normalizeCodex(codexPayload(model), config),
        now: () => clock.now,
        deadline: clock.deadline,
      };
      await usingStorage(path, async (storage) => {
        const catalog = new ModelCatalog({
          ...options,
          storage,
          instances: removal === "eviction" ? [] : configs,
        });
        try {
          // Drain startup revalidation before installing the failing deletion edge.
          await catalog.refresh();
          model = "fresh";
          const db = new DatabaseSync(path);
          try {
            db.exec(
              "CREATE TRIGGER reject_delete BEFORE DELETE ON model_catalog WHEN OLD.instance='account-0' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
            );
            if (removal === "explicit removal")
              await expect(catalog.removeInstance("account-0")).rejects.toThrow("persistence");
            catalog.registerInstance(instance("codex", "replacement"));
            expect(await catalog.refresh({ instance: "replacement" })).toMatchObject([
              { error: "persistence_failed", stale: true },
            ]);
            expect(catalog.list({ instance: "replacement" }).models).toEqual([]);

            // Reopen before graceful shutdown can retry deletion. This checks durable
            // startup admission, without claiming to simulate process death.
            await usingStorage(path, async (reopened) => {
              const loaded = reopened.load();
              expect(loaded).toHaveLength(64);
              expect(loaded.some((row) => row.instance === "replacement")).toBe(false);
            });
            await usingStorage(path, async (restartStorage) => {
              const discovery = Promise.withResolvers<void>();
              const restarted = new ModelCatalog({
                ...options,
                discover: async (config) => {
                  await discovery.promise;
                  return options.discover(config);
                },
                storage: restartStorage,
                instances: [instance("codex", "account-1")],
              });
              try {
                expect(restarted.list().models[0]?.id).toBe("cached");
                expect(restarted.list().instances[0]?.refreshing).toBe(true);
                discovery.resolve();
                expect(await restarted.refresh()).toMatchObject([
                  { stale: false, refreshing: false },
                ]);
                expect(restarted.list().models[0]?.id).toBe("fresh");
              } finally {
                discovery.resolve();
                await restarted.close();
              }
            });

            db.exec("DROP TRIGGER reject_delete");
            expect(await catalog.refresh({ instance: "replacement" })).toMatchObject([
              { stale: false, refreshing: false },
            ]);
            expect(catalog.list({ instance: "replacement" }).models[0]?.id).toBe("fresh");
          } finally {
            try {
              db.exec("DROP TRIGGER IF EXISTS reject_delete");
            } finally {
              db.close();
            }
          }
        } finally {
          await catalog.close();
        }
      });
      await usingStorage(path, async (storage) => {
        const rows = storage.load();
        expect(rows).toHaveLength(64);
        expect(rows.some((row) => row.instance === "account-0")).toBe(false);
        expect(rows.find((row) => row.instance === "replacement")?.models[0]?.id).toBe("fresh");
      });
    });
  },
);
