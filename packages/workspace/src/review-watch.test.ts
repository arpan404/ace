import { expect, it } from "vitest";
import { batches, exec, fixture } from "./test-support.ts";

it.each(["tracked", "untracked"])(
  "native batches reflect files becoming %s without refresh",
  async (state) => {
    const { service, root, file } = await fixture({}, true);
    await file(".gitignore", "*.log\n");
    await file("tracked.log", "content");
    if (state === "untracked") await exec("git", ["-C", root, "add", "-f", "tracked.log"]);
    const events = batches();
    const watcher = await service.watch({ onChange: events.onChange });
    try {
      expect(watcher.mode).toBe("native");
      await exec("git", [
        "-C",
        root,
        ...(state === "tracked" ? ["add", "-f"] : ["rm", "--cached"]),
        "tracked.log",
      ]);
      const marker = events.next("marker", "created");
      await file("marker", "acknowledge native processing");
      await marker;
      expect(events.history.flat()).toContainEqual({
        path: "tracked.log",
        kind: state === "tracked" ? "created" : "deleted",
      });
      expect(events.history.flat().some((change) => change.path.startsWith(".git/"))).toBe(false);
    } finally {
      await watcher.dispose();
    }
  },
);

it("native writes stay pending for 100 ms and coalesce without explicit refresh", async () => {
  const { watch } = await import("node:fs");
  let now = 0;
  const scheduled = new Set<{ at: number; run: () => void | Promise<void> }>();
  const clock = {
    after(run: () => void | Promise<void>, milliseconds: number) {
      const timer = { at: now + milliseconds, run };
      scheduled.add(timer);
      return () => {
        scheduled.delete(timer);
      };
    },
    every() {
      throw new Error("Native mode must not poll");
    },
  };
  async function advance(milliseconds: number) {
    now += milliseconds;
    for (const timer of scheduled)
      if (timer.at <= now) {
        scheduled.delete(timer);
        await timer.run();
      }
  }
  let acknowledged: (() => void) | undefined;
  function nativeEvent() {
    return new Promise<void>((resolve) => {
      acknowledged = resolve;
    });
  }
  const { service, file } = await fixture({
    runtime: {
      clock,
      watch(root, options, onEvent) {
        return watch(root, options, (event, path) => {
          onEvent(event, path);
          if (path === "a") {
            acknowledged?.();
            acknowledged = undefined;
          }
        });
      },
    },
  });
  await file("a", "initial");
  const events = batches();
  const watcher = await service.watch({ onChange: events.onChange });
  try {
    expect(watcher.mode).toBe("native");
    let observed = nativeEvent();
    await file("a", "first");
    await observed;
    await advance(49);
    expect(events.history).toEqual([]);
    observed = nativeEvent();
    await file("a", "second larger write");
    await observed;
    await advance(50);
    expect(events.history).toEqual([]);
    const delivered = events.next("a", "changed");
    await advance(1);
    expect(await delivered).toEqual([{ path: "a", kind: "changed" }]);
    expect(events.history).toHaveLength(1);
  } finally {
    await watcher.dispose();
  }
});

it("native linked-worktree batches follow the external index through tracking transitions", async () => {
  const base = await fixture({}, true);
  await base.file(".gitignore", "*.log\n");
  await exec("git", ["-C", base.root, "add", ".gitignore"]);
  await exec("git", [
    "-C",
    base.root,
    "-c",
    "user.name=ace-test",
    "-c",
    "user.email=ace@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const worktree = await fixture();
  await exec("git", ["-C", base.root, "worktree", "add", "--detach", worktree.root]);
  await worktree.file("tracked.log", "content");
  const events = batches();
  const watcher = await worktree.service.watch({ onChange: events.onChange });
  try {
    expect(watcher.mode).toBe("native");
    await exec("git", ["-C", worktree.root, "add", "-f", "tracked.log"]);
    let observed = events.next("marker-add", "created");
    await worktree.file("marker-add", "acknowledge native batch");
    await observed;
    expect(events.history.flat()).toContainEqual({ path: "tracked.log", kind: "created" });
    await exec("git", ["-C", worktree.root, "rm", "--cached", "tracked.log"]);
    observed = events.next("marker-remove", "created");
    await worktree.file("marker-remove", "acknowledge native batch");
    await observed;
    expect(events.history.flat()).toContainEqual({ path: "tracked.log", kind: "deleted" });
    expect(events.history.flat().some((change) => change.path.includes(".git"))).toBe(false);
  } finally {
    await watcher.dispose();
  }
});
