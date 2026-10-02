import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage } from "./index.ts";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

test("SQLite write failure reports persistence failure and retains the last valid picker rows", async () => {
  const work = await workspace();
  const path = join(work.path, "models.sqlite");
  const clock = new Clock();
  let calls = 0;
  const catalog = new ModelCatalog({
    storage: openModelStorage(path),
    instances: [instance()],
    discover: async () =>
      normalizeCodex(codexPayload(++calls === 1 ? "first" : "second"), instance()),
    now: () => clock.now,
    deadline: clock.deadline,
  });
  const lock = new DatabaseSync(path);
  try {
    await catalog.refresh();
    lock.exec("BEGIN IMMEDIATE");
    expect(await catalog.refresh()).toMatchObject([{ error: "persistence_failed" }]);
    expect(catalog.list().models[0]?.id).toBe("first");
    lock.exec("ROLLBACK");
    await catalog.refresh();
    expect(catalog.list().models[0]?.id).toBe("second");
  } finally {
    lock.close();
    await catalog.close();
    await work.close();
  }
});

test("invalid persisted native model records are rejected on startup", async () => {
  const work = await workspace();
  const path = join(work.path, "models.sqlite");
  const storage = openModelStorage(path);
  await storage.close();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO model_catalog VALUES (?, ?)").run(
    "bad",
    JSON.stringify({
      provider: "codex",
      instance: "bad",
      revision: "1",
      refreshedAt: 1000,
      models: [{ id: "bad" }],
    }),
  );
  db.close();
  try {
    expect(() => openModelStorage(path)).toThrow();
  } finally {
    await work.close();
  }
});
