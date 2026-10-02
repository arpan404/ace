import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage } from "./index.ts";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

test.each([2, 64])(
  "failed account removal leaves another account refreshable at %i durable rows",
  async (count) => {
    const work = await workspace();
    try {
      const path = join(work.path, "models.sqlite");
      const storage = openModelStorage(path);
      try {
        const clock = new Clock();
        let model = "cached";
        const options = {
          discover: async (config: ReturnType<typeof instance>) =>
            normalizeCodex(codexPayload(model), config),
          now: () => clock.now,
          deadline: clock.deadline,
        };
        const catalog = new ModelCatalog({
          ...options,
          storage,
          instances: Array.from({ length: count }, (_, index) =>
            instance("codex", `account-${index}`),
          ),
        });
        try {
          await catalog.refresh();
          const db = new DatabaseSync(path);
          try {
            db.exec(
              "CREATE TRIGGER reject_delete BEFORE DELETE ON model_catalog WHEN OLD.instance='account-0' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
            );
            await expect(catalog.removeInstance("account-0")).rejects.toThrow("persistence");
            model = "fresh";
            const refreshed = await catalog.refresh({ instance: "account-1" });
            expect(refreshed).toMatchObject([{ stale: false, refreshing: false }]);
            expect(refreshed[0]?.error).toBeUndefined();
            expect(catalog.list({ instance: "account-1" }).models[0]?.id).toBe("fresh");
            // The failing removal remains owned and visible to its caller.
            await expect(catalog.removeInstance("account-0")).rejects.toThrow("persistence");
            catalog.registerInstance({
              ...instance("codex", "account-0"),
              loginRevision: "account-2",
            });
            expect(await catalog.refresh({ instance: "account-0" })).toMatchObject([
              { error: "persistence_failed" },
            ]);
            expect(catalog.list({ instance: "account-0" }).models).toEqual([]);

            const reopened = openModelStorage(path);
            try {
              const rows = reopened.load();
              expect(rows).toHaveLength(count);
              expect(rows.find((row) => row.instance === "account-1")?.models[0]?.id).toBe("fresh");
              expect(rows.some((row) => row.instance === "account-0")).toBe(true);
              expect(rows.find((row) => row.instance === "account-0")?.revision).toBe("account-1");
            } finally {
              await reopened.close();
            }
            const restartStorage = openModelStorage(path);
            try {
              const restarted = new ModelCatalog({
                ...options,
                storage: restartStorage,
                instances: [instance("codex", "account-1")],
              });
              try {
                expect(restarted.list().models[0]?.id).toBe("fresh");
                expect(restarted.list().instances[0]?.refreshing).toBe(false);
              } finally {
                await restarted.close();
              }
            } finally {
              await restartStorage.close();
            }
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
      } finally {
        await storage.close();
      }
    } finally {
      await work.close();
    }
  },
);
