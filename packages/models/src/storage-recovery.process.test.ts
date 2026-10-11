import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openModelStorage, normalizeCodex } from "./index.ts";
import { instance, workspace, codexPayload } from "./testing/support.ts";

test("model persistence starts a replacement worker after a crash and stores later changes", async () => {
  const work = await workspace();
  const path = join(work.path, "models.sqlite");
  let current: Worker | undefined;
  let resume: (() => void) | undefined;
  const storage = openModelStorage(path, {
    spawn(url, options) {
      current = new Worker(url, options);
      return current;
    },
    delay(callback) {
      resume = callback;
      return () => {
        resume = undefined;
      };
    },
  });
  const entry = {
    provider: "codex" as const,
    instance: "codex",
    loginRevision: "account-1",
    revision: "account-1",
    refreshedAt: 1000,
    models: normalizeCodex(codexPayload("before"), instance()),
  };
  try {
    await storage.replace(entry);
    if (!current) throw new Error("Storage did not admit the first write");
    const exited = once(current, "exit");
    await current.terminate();
    await exited;
    const later = storage.replace({
      ...entry,
      models: normalizeCodex(codexPayload("after"), instance()),
    });
    resume?.();
    await later;
    await storage.close();
    const reopened = openModelStorage(path);
    try {
      expect(reopened.load()[0]?.models[0]?.id).toBe("after");
    } finally {
      await reopened.close();
    }
  } finally {
    await storage.close();
    await work.close();
  }
});
