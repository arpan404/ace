import { spawn } from "node:child_process";
import { watch as nativeWatch } from "node:fs";
import { dirname, join, relative } from "node:path";
import { rename, rm } from "node:fs/promises";
import { expect, test } from "vitest";
import { workspaceRuntime, type WorkspaceRuntime } from "./index.ts";
import { batches, exec, fixture } from "./test-support.ts";

async function watchedRepository(environment?: NodeJS.ProcessEnv) {
  const sources = new Set<{
    root: string;
    recursive: boolean;
    notify: Parameters<WorkspaceRuntime["watch"]>[2];
  }>();
  const timers = new Set<() => void | Promise<void>>();
  const h = await fixture(
    {
      runtime: {
        ...(environment ? { environment } : {}),
        watch(root, options, notify) {
          const source = { root, recursive: options.recursive, notify };
          sources.add(source);
          const handle = nativeWatch(root, options, () => {});
          handle.once("close", () => sources.delete(source));
          return handle;
        },
        clock: {
          after(run) {
            timers.add(run);
            return () => {
              timers.delete(run);
            };
          },
          every() {
            throw new Error("Unexpected polling");
          },
        },
      },
    },
    true,
  );
  return {
    ...h,
    sources,
    timers,
    async notify(path: string) {
      for (const source of sources) {
        const local = relative(source.root, path);
        if (!local.startsWith("..") && (source.recursive || dirname(path) === source.root))
          source.notify("rename", local);
      }
      const pending = [...timers];
      for (const task of pending) {
        timers.delete(task);
        await task();
      }
    },
  };
}

test.each(["external", "inside"])(
  "%s excludes edits and atomic replacement reconcile existing files without flush",
  async (location) => {
    const h = await watchedRepository();
    const peer = await fixture();
    const excludes = join(location === "external" ? peer.service.root : h.service.root, "rules");
    await exec("git", ["-C", h.root, "config", "core.excludesFile", excludes]);
    await h.file("a.ts", "untracked");
    await h.file("tracked.ts", "tracked");
    await exec("git", ["-C", h.root, "add", "tracked.ts"]);
    const events = batches();
    const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
    try {
      expect(subscription.mode).toBe("native");
      // The configured source is initially absent.
      const write = location === "external" ? peer.file : h.file;
      await write("rules", "*.ts\n");
      await h.notify(excludes);
      expect(events.history.flat()).toContainEqual({ path: "a.ts", kind: "deleted" });
      expect(events.history.flat().some((change) => change.path === "tracked.ts")).toBe(false);
      await write("replacement", "");
      await rename(join(dirname(excludes), "replacement"), excludes);
      await h.notify(excludes);
      expect(events.history.flat()).toContainEqual({ path: "a.ts", kind: "created" });
      if (location === "external")
        expect(events.history.flat().map((change) => change.path)).toEqual(["a.ts", "a.ts"]);
    } finally {
      await subscription.dispose();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.sources.size).toBe(0);
    expect(h.timers.size).toBe(0);
  },
);

test("changing the configured excludes source rebinds native subscriptions", async () => {
  const h = await watchedRepository();
  const peer = await fixture();
  const first = join(peer.service.root, "first");
  const second = join(peer.service.root, "second");
  await peer.file("first", "a.ts\n");
  await peer.file("second", "");
  await h.file("a.ts", "untracked");
  await exec("git", ["-C", h.root, "config", "core.excludesFile", first]);
  const events = batches();
  const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
  try {
    await exec("git", ["-C", h.root, "config", "core.excludesFile", second]);
    await h.notify(join(h.service.root, ".git/config"));
    expect(events.history.flat()).toContainEqual({ path: "a.ts", kind: "created" });
    events.history.length = 0;
    await peer.file("second", "a.ts\n");
    await h.notify(second);
    expect(events.history.flat()).toEqual([{ path: "a.ts", kind: "deleted" }]);
    await rm(second);
    await h.notify(second);
    expect(events.history.flat()).toContainEqual({ path: "a.ts", kind: "created" });
  } finally {
    await subscription.dispose();
  }
});

test("the default Git excludes source is observed even when its parent does not exist yet", async () => {
  const peer = await fixture();
  const h = await watchedRepository({
    ...workspaceRuntime().environment,
    XDG_CONFIG_HOME: peer.service.root,
  });
  await h.file("a.ts", "untracked");
  const events = batches();
  const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
  try {
    expect(subscription.mode).toBe("native");
    await peer.file("git/ignore", "a.ts\n");
    await h.notify(join(peer.service.root, "git"));
    expect(events.history.flat()).toEqual([{ path: "a.ts", kind: "deleted" }]);
    await peer.file("git/ignore", "");
    await h.notify(join(peer.service.root, "git/ignore"));
    expect(events.history.flat()).toEqual([
      { path: "a.ts", kind: "deleted" },
      { path: "a.ts", kind: "created" },
    ]);
  } finally {
    await subscription.dispose();
  }
});

test("native file changes remain available when Git is not installed", async () => {
  const h = await fixture({
    runtime: {
      spawn(binary, args, options) {
        return spawn(binary === "git" ? "ace-fixture-missing-git" : binary, args, options);
      },
    },
  });
  const events = batches();
  const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
  try {
    expect(subscription.mode).toBe("native");
    const delivered = events.next("saved.txt", "created");
    await h.file("saved.txt", "saved");
    expect(await delivered).toContainEqual({ path: "saved.txt", kind: "created" });
  } finally {
    await subscription.dispose();
  }
});
