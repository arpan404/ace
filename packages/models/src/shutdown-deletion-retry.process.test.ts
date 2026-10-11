import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage } from "./index.ts";
import { workspace, instance, codexPayload } from "./testing/support.ts";

test("failed shutdown deletions keep storage open and a later close durably retries them", async () => {
  const work = await workspace();
  const path = join(work.path, "models.sqlite");
  const storage = openModelStorage(path);
  const config = instance();
  const models = normalizeCodex(codexPayload("retained"), config);
  const catalog = new ModelCatalog({
    instances: [config],
    storage,
    now: () => 1,
    deadline: () => () => {},
    discover: async () => models,
  });
  const db = new DatabaseSync(path);
  try {
    await catalog.refresh();
    db.exec(
      "CREATE TRIGGER reject_delete BEFORE DELETE ON model_catalog BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(catalog.removeInstance(config.id)).rejects.toThrow("persistence");
    await expect(catalog.close()).rejects.toThrow("cleanup failed");
    // A public storage operation proves cleanup retained the usable persistence owner.
    await storage.replace({
      provider: "codex",
      instance: config.id,
      loginRevision: "account-1",
      revision: "account-1",
      refreshedAt: 1,
      models,
    });
    db.exec("DROP TRIGGER reject_delete");
    await catalog.close();
    const reopened = openModelStorage(path);
    try {
      expect(reopened.load()).toEqual([]);
    } finally {
      await reopened.close();
    }
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_delete");
    db.close();
    await catalog.close().catch(() => {});
    await storage.close();
    await work.close();
  }
});
