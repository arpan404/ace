import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { batches, fixture } from "./test-support.ts";

test("one ignore process reconciles nested visible files while pruning ignored directories", async () => {
  let processes = 0;
  const h = await fixture(
    {
      runtime: {
        spawn(binary, args, options) {
          processes++;
          return spawn(binary, args, options);
        },
      },
    },
    true,
  );
  await h.file(".gitignore", "ignored/\n*.log\n!keep.log\n");
  await h.file("old/a/b/c.ts", "original");
  const events = batches();
  const watcher = await h.service.watch({ onChange: events.onChange });
  try {
    await h.file("old/a/b/c.ts", "changed");
    await h.file("new/a/b/file.ts", "visible");
    await h.file("new/a/b/keep.log", "visible negation");
    await h.file("new/a/b/hide.log", "hidden");
    await h.file("ignored/deep/file.ts", "hidden directory");
    const before = processes;
    await watcher.flush();
    expect(processes - before).toBe(1);
    expect(events.history.flat()).toEqual(
      expect.arrayContaining([
        { path: "old/a/b/c.ts", kind: "changed" },
        { path: "new/a/b/file.ts", kind: "created" },
        { path: "new/a/b/keep.log", kind: "created" },
      ]),
    );
    expect(
      events.history
        .flat()
        .some((change) => change.path.includes("hide.log") || change.path.startsWith("ignored")),
    ).toBe(false);
  } finally {
    await watcher.dispose();
  }
});

test("idle polling backs off and returns to the initial delay after a visible change", async () => {
  const timers = new Map<number, { delay: number; run(): void | Promise<void> }>();
  let id = 0;
  const h = await fixture({
    watchMode: "polling",
    runtime: {
      clock: {
        after(run, delay) {
          const key = ++id;
          timers.set(key, { run, delay });
          return () => {
            timers.delete(key);
          };
        },
        every() {
          throw new Error("Polling must wait for its previous reconciliation");
        },
      },
    },
  });
  const events = batches();
  const watcher = await h.service.watch({ onChange: events.onChange, onWarning() {} });
  const next = () => {
    const entry = timers.entries().next().value;
    if (!entry) throw new Error("No timer");
    return entry;
  };
  const fire = async () => {
    const [key, timer] = next();
    timers.delete(key);
    await timer.run();
  };
  try {
    expect(next()[1].delay).toBe(1000);
    await fire();
    expect(next()[1].delay).toBe(2000);
    await fire();
    expect(next()[1].delay).toBe(4000);
    await h.file("new.txt", "changed");
    await fire();
    expect(events.history.flat()).toContainEqual({ path: "new.txt", kind: "created" });
    expect(next()[1].delay).toBe(1000);
  } finally {
    await watcher.dispose();
  }
  expect(timers.size).toBe(0);
});
