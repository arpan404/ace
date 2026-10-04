import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelCatalog, normalizeCodex, openModelStorage } from "./index.ts";
import { Clock, codexPayload, instance, workspace } from "./testing/support.ts";

test("large model replacements reject byte overflow while admitted rows remain durable", async () => {
  const work = await workspace();
  const path = join(work.path, "models.sqlite");
  const storage = openModelStorage(path);
  const config = instance();
  const base = normalizeCodex(codexPayload(), config)[0];
  if (!base) throw new Error("Missing model");
  const models = Array.from({ length: 512 }, (_, index) => ({
    ...base,
    id: `model-${index}`,
    nativeModelId: `model-${index}`,
    raw: { json: JSON.stringify({ data: "x".repeat(1900) }), truncated: false },
  }));
  try {
    const writes = Array.from({ length: 16 }, (_, refreshedAt) =>
      storage.replace({
        provider: config.provider,
        instance: config.id,
        revision: config.loginRevision,
        refreshedAt,
        models,
      }),
    );
    const settled = Promise.allSettled(writes);
    await storage.close();
    const results = await settled;
    expect(results[0]?.status).toBe("fulfilled");
    expect(
      results.some(
        (result) =>
          result.status === "rejected" && String(result.reason).includes("byte backpressure"),
      ),
    ).toBe(true);
    const last = results.findLastIndex((result) => result.status === "fulfilled");
    const reopened = openModelStorage(path);
    try {
      const entry = reopened.load()[0];
      expect(entry?.refreshedAt).toBe(last);
      expect(entry?.models.at(-1)?.nativeModelId).toBe("model-511");
    } finally {
      await reopened.close();
    }
  } finally {
    await storage.close();
    await work.close();
  }
});

test("closing a full queue preserves every admitted replacement across restart", async () => {
  const work = await workspace();
  const path = join(work.path, "models.sqlite");
  const storage = openModelStorage(path);
  const entries = Array.from({ length: 128 }, (_, index) => {
    const config = instance("codex", `account-${index % 64}`);
    return {
      provider: config.provider,
      instance: config.id,
      revision: config.loginRevision,
      refreshedAt: index,
      models: normalizeCodex(codexPayload(`model-${index}`), config),
    };
  });
  try {
    const writes = Promise.allSettled(entries.map((entry) => storage.replace(entry)));
    const last = entries.at(-1);
    if (!last) throw new Error("Missing entry");
    const overflow = expect(Promise.resolve(storage.replace(last))).rejects.toThrow("queue full");
    const closing = storage.close();
    expect(storage.close()).toBe(closing);
    await expect(Promise.resolve(storage.replace(last))).rejects.toThrow("closed");
    await expect(Promise.resolve(storage.remove(last.instance))).rejects.toThrow("closed");
    await overflow;
    await closing;
    expect((await writes).every((result) => result.status === "fulfilled")).toBe(true);
    const reopened = openModelStorage(path);
    try {
      const loaded = reopened.load();
      expect(loaded).toHaveLength(64);
      for (let index = 64; index < 128; index++) {
        expect(
          loaded.find((entry) => entry.instance === `account-${index % 64}`)?.models[0]?.id,
        ).toBe(`model-${index}`);
      }
    } finally {
      await reopened.close();
    }
  } finally {
    await storage.close();
    await work.close();
  }
});

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
