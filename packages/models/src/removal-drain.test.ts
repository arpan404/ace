import { expect, test } from "vitest";
import { setImmediate } from "node:timers/promises";
import { ModelCatalog } from "./index.ts";

// Public catalog regression complements the real socket/process regression in the daemon.
test("failed removal and concurrent retry drain discovery from a superseded generation", async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const failedStorage = Promise.withResolvers<void>();
  let fail = true;
  const instance = {
    id: "account",
    provider: "codex" as const,
    executable: "/controlled/codex",
    cwd: "/temporary/daemon",
    loginRevision: "1",
  };
  const catalog = new ModelCatalog({
    instances: [instance],
    now: () => 100,
    deadline: () => () => {},
    storage: {
      load: () => [],
      replace() {},
      close() {},
      remove() {
        if (fail) {
          fail = false;
          failedStorage.resolve();
          throw new Error("Transient persistence failure");
        }
      },
    },
    discover: async (_instance, signal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await cleanup.promise;
      throw new Error("Discovery cancelled after cleanup");
    },
  });
  try {
    const refresh = catalog.refresh();
    await started.promise;
    // The old state is no longer the current state when removal starts.
    catalog.registerInstance({ ...instance, loginRevision: "2" });
    await aborted.promise;
    await refresh;
    let firstSettled = false;
    let retrySettled = false;
    const first = catalog.removeInstance(instance.id);
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await failedStorage.promise;
    const retry = catalog.removeInstance(instance.id);
    void retry.then(
      () => {
        retrySettled = true;
      },
      () => {
        retrySettled = true;
      },
    );
    await setImmediate();
    expect(firstSettled).toBe(false);
    expect(retrySettled).toBe(false);
    cleanup.resolve();
    expect((await Promise.allSettled([first, retry])).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    await catalog.removeInstance(instance.id);
    expect(catalog.list().instances).toEqual([]);
    // A completed removal releases admission for a fresh generation.
    catalog.registerInstance({ ...instance, loginRevision: "3" });
    expect(catalog.list().instances).toMatchObject([{ instance: instance.id }]);
  } finally {
    cleanup.resolve();
    await catalog.close();
  }
});
