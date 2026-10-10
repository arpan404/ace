import { expect, test } from "vitest";
import { join } from "node:path";
import { ModelCatalog, openModelStorage } from "./index.ts";
import { workspace, instance } from "./testing/support.ts";

test("a failed admitted session write still closes the model persistence worker", async () => {
  const work = await workspace();
  const storage = openModelStorage(join(work.path, "models.sqlite"));
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const config = instance("acp");
  const catalog = new ModelCatalog({
    instances: [config],
    now: () => 1,
    discover: async () => [],
    deadline: () => () => {},
    storage: {
      ...storage,
      async replace() {
        started.resolve();
        await release.promise;
        throw new Error("Session write failed");
      },
    },
  });
  try {
    const write = catalog.updateFromSession(config, {
      models: { currentModelId: "model", availableModels: [{ modelId: "model", name: "Model" }] },
    });
    const writeFailed = expect(write).rejects.toThrow("Session write failed");
    await started.promise;
    const close = catalog.close();
    const closeFailed = expect(close).rejects.toThrow("Session model persistence failed");
    release.resolve();
    await writeFailed;
    await closeFailed;
    await expect(storage.remove("unused")).rejects.toThrow("closed");
  } finally {
    release.resolve();
    await storage.close();
    await work.close();
  }
});
