import { watch as nativeWatch } from "node:fs";
import { expect, test } from "vitest";
import { filesystem, type WorkspaceRuntime } from "./index.ts";
import { batches, fixture } from "./test-support.ts";

function clock() {
  const timers = new Set<{ delay: number; run(): void | Promise<void> }>();
  return {
    timers,
    clock: {
      after(run: () => void | Promise<void>, delay: number) {
        const timer = { run, delay };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
      every() {
        throw new Error("Native reconciliation must not poll");
      },
    },
    async fire() {
      const timer = timers.values().next().value;
      if (!timer) throw new Error("Expected an owned retry");
      timers.delete(timer);
      await timer.run();
    },
  };
}

test("a failed native save keeps its snapshot and retries without another event or flush", async () => {
  const time = clock();
  let notify: Parameters<WorkspaceRuntime["watch"]>[2] | undefined;
  let failing = false;
  const h = await fixture({
    filesystem: {
      ...filesystem,
      async lstat(path) {
        if (failing && path.endsWith("saved.txt"))
          throw Object.assign(new Error("temporary"), { code: "EIO" });
        return filesystem.lstat(path);
      },
    },
    runtime: {
      clock: time.clock,
      watch(root, options, listener) {
        notify = listener;
        // A real disposable watch handle with deterministic notification delivery.
        return nativeWatch(root, options, () => {});
      },
    },
  });
  await h.file("saved.txt", "before");
  const events = batches();
  const warnings: string[] = [];
  const subscription = await h.service.watch({
    onChange: events.onChange,
    onWarning: (warning) => warnings.push(warning),
  });
  try {
    expect(subscription.mode).toBe("native");
    await h.file("saved.txt", "after with more bytes");
    failing = true;
    notify?.("change", "saved.txt");
    await time.fire();
    expect(warnings).toHaveLength(1);
    expect(events.history).toEqual([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(time.timers.size).toBe(1);
      expect([...time.timers][0]?.delay).toBeLessThanOrEqual(30_000);
      await time.fire();
      expect(events.history).toEqual([]);
    }
    failing = false;
    await time.fire();
    expect(events.history.flat()).toEqual([{ path: "saved.txt", kind: "changed" }]);
    expect(time.timers.size).toBe(0);
    // Later successful edits still coalesce with explicit flush.
    await h.file("saved.txt", "final");
    notify?.("change", "saved.txt");
    await subscription.flush();
    expect(events.history.flat()).toEqual([
      { path: "saved.txt", kind: "changed" },
      { path: "saved.txt", kind: "changed" },
    ]);
    failing = true;
    notify?.("change", "saved.txt");
    await time.fire();
  } finally {
    await subscription.dispose();
  }
  expect(time.timers.size).toBe(0);
  expect(events.history.flat()).toHaveLength(2);
});
