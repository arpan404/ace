import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage } from "./index.ts";
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

test("durable capacity rejects new accounts but permits updates and reuse after removal", async () => {
  const work = await workspace();
  const path = join(work.path, "models.sqlite");
  const storage = openModelStorage(path);
  try {
    for (let index = 0; index < 64; index++) await storage.replace(entry(`account-${index}`));
    await storage.replace(entry("account-0", "updated"));
    await expect(Promise.resolve(storage.replace(entry("replacement")))).rejects.toThrow(
      "persistence",
    );
    await storage.close();
    const reopened = openModelStorage(path);
    try {
      const loaded = reopened.load();
      expect(loaded).toHaveLength(64);
      expect(loaded.find((row) => row.instance === "account-0")?.models[0]?.id).toBe("updated");
      await reopened.remove("account-0");
      await reopened.replace(entry("replacement"));
    } finally {
      await reopened.close();
    }
    const final = openModelStorage(path);
    try {
      const loaded = final.load();
      expect(loaded).toHaveLength(64);
      expect(loaded.some((row) => row.instance === "account-0")).toBe(false);
      expect(loaded.find((row) => row.instance === "replacement")?.models[0]?.id).toBe("cached");
    } finally {
      await final.close();
    }
  } finally {
    await storage.close();
    await work.close();
  }
});

test.each(["eviction", "explicit removal"])(
  "failed %s cannot overflow durable capacity or make the catalog unusable after restart",
  async (removal) => {
    const work = await workspace();
    const path = join(work.path, "models.sqlite");
    const configs = Array.from({ length: 64 }, (_, index) => instance("codex", `account-${index}`));
    const seed = openModelStorage(path);
    for (const config of configs) await seed.replace(entry(config.id));
    await seed.close();
    const clock = new Clock();
    const options = {
      discover: async (config: ReturnType<typeof instance>) =>
        normalizeCodex(codexPayload("fresh"), config),
      now: () => clock.now,
      deadline: clock.deadline,
    };
    const catalog = new ModelCatalog({
      ...options,
      storage: openModelStorage(path),
      instances: removal === "eviction" ? [] : configs,
    });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON model_catalog WHEN OLD.instance='account-0' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    try {
      if (removal === "explicit removal")
        await expect(catalog.removeInstance("account-0")).rejects.toThrow("persistence");
      catalog.registerInstance(instance("codex", "replacement"));
      expect(await catalog.refresh({ instance: "replacement" })).toMatchObject([
        { error: "persistence_failed", stale: true },
      ]);
      expect(catalog.list({ instance: "replacement" }).models).toEqual([]);

      // Reopen before graceful shutdown can retry deletion, as after a crash.
      const storage = openModelStorage(path);
      const loaded = storage.load();
      expect(loaded).toHaveLength(64);
      expect(loaded.some((row) => row.instance === "replacement")).toBe(false);
      await storage.close();
      const restarted = new ModelCatalog({
        ...options,
        storage: openModelStorage(path),
        instances: [instance("codex", "account-1")],
      });
      try {
        expect(restarted.list().models[0]?.id).toBe("cached");
        expect(restarted.list().instances[0]?.refreshing).toBe(false);
      } finally {
        await restarted.close();
      }

      db.exec("DROP TRIGGER reject_delete");
      expect(await catalog.refresh({ instance: "replacement" })).toMatchObject([
        { stale: false, refreshing: false },
      ]);
      expect(catalog.list({ instance: "replacement" }).models[0]?.id).toBe("fresh");
      await catalog.close();
      const final = openModelStorage(path);
      try {
        const rows = final.load();
        expect(rows).toHaveLength(64);
        expect(rows.some((row) => row.instance === "account-0")).toBe(false);
        expect(rows.find((row) => row.instance === "replacement")?.models[0]?.id).toBe("fresh");
      } finally {
        await final.close();
      }
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_delete");
      db.close();
      await catalog.close();
      await work.close();
    }
  },
);
