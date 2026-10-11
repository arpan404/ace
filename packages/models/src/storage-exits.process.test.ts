import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openModelStorage, normalizeCodex } from "./index.ts";
import { workspace, instance, codexPayload } from "./testing/support.ts";

class StoragePort extends EventEmitter {
  postMessage(): void {}
  terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

test("every replacement worker exit rejects its admitted persistence requests", async () => {
  const work = await workspace();
  let current = new StoragePort();
  let resume: (() => void) | undefined;
  const storage = openModelStorage(join(work.path, "models.sqlite"), {
    spawn() {
      current = new StoragePort();
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
    refreshedAt: 1,
    models: normalizeCodex(codexPayload("model"), instance()),
  };
  try {
    for (let crash = 0; crash < 3; crash++) {
      const pending = storage.replace(entry);
      const failed = expect(pending).rejects.toThrow("worker failed");
      if (crash) {
        resume?.();
        await setImmediate();
      }
      current.emit("exit", 1);
      await failed;
    }
  } finally {
    await storage.close();
    await work.close();
  }
});
