import { watch as nativeWatch } from "node:fs";
import { sep, join } from "node:path";
import { expect, test } from "vitest";
import { filesystem } from "./index.ts";
import { batches, exec, fixture } from "./test-support.ts";

test("detachment and repeated detached HEAD updates leave unrelated inventory untouched when ignores stay the same", async () => {
  const timers = new Set<() => void | Promise<void>>();
  let scheduled: (() => void) | undefined;
  let headEvent: (() => void) | undefined;
  let saveEvent: (() => void) | undefined;
  let unavailable = false;
  const h = await fixture(
    {
      filesystem: {
        ...filesystem,
        lstat(path) {
          if (unavailable && path.endsWith(`${sep}unrelated`))
            throw Object.assign(new Error("Unrelated inventory is temporarily unavailable"), {
              code: "EIO",
            });
          return filesystem.lstat(path);
        },
      },
      runtime: {
        watch(root, options, listener) {
          return nativeWatch(root, options, (event, filename) => {
            listener(event, filename);
            const path = filename?.split(sep).join("/");
            if (options.recursive && (path === ".git/HEAD" || path === ".git/HEAD.lock"))
              headEvent?.();
            if (options.recursive && path === "a.ts") saveEvent?.();
          });
        },
        clock: {
          after(task) {
            timers.add(task);
            scheduled?.();
            return () => {
              timers.delete(task);
            };
          },
          every() {
            throw new Error("Native watcher must not poll");
          },
        },
      },
    },
    true,
  );
  const reconcile = async () => {
    if (!timers.size)
      await new Promise<void>((resolve) => {
        scheduled = resolve;
      });
    scheduled = undefined;
    const pending = [...timers];
    for (const task of pending) {
      timers.delete(task);
      await task();
    }
  };
  const peer = await fixture();
  await peer.file("base-rules", "");
  await peer.file("rules", "a.ts\n");
  await peer.file("branch.conf", `[core]\nexcludesFile = ${join(peer.service.root, "rules")}\n`);
  await h.file("a.ts", "visible");
  await h.file("unrelated/deep/file.txt", "unrelated inventory");
  await exec("git", ["-C", h.root, "symbolic-ref", "HEAD", "refs/heads/base"]);
  await exec("git", ["-C", h.root, "add", "a.ts", "unrelated"]);
  const commit = async (message: string) => {
    await exec("git", [
      "-C",
      h.root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@ace.local",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ]);
    return (await exec("git", ["-C", h.root, "rev-parse", "HEAD"])).stdout.trim();
  };
  const first = await commit("First");
  const second = await commit("Second");
  // Keep the watched file untracked so branch-dependent excludes affect it.
  await exec("git", ["-C", h.root, "rm", "--cached", "a.ts"]);
  await exec("git", ["-C", h.root, "branch", "other", first]);
  await exec("git", [
    "-C",
    h.root,
    "config",
    "core.excludesFile",
    join(peer.service.root, "base-rules"),
  ]);
  await exec("git", [
    "-C",
    h.root,
    "config",
    "--add",
    "includeIf.onbranch:other.path",
    join(peer.service.root, "branch.conf"),
  ]);
  const events = batches();
  const warnings: string[] = [];
  const subscription = await h.service.watch({
    onChange: events.onChange,
    onWarning: (message) => warnings.push(message),
  });
  const updateHead = async (args: string[]) => {
    const delivered = new Promise<void>((resolve) => {
      headEvent = resolve;
    });
    await exec("git", ["-C", h.root, ...args]);
    await delivered;
    headEvent = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await reconcile();
  };
  try {
    expect(subscription.mode).toBe("native");
    unavailable = true;
    await updateHead(["update-ref", "--no-deref", "HEAD", first]);
    expect(warnings).toEqual([]);
    for (const oid of [second, first, second, first]) {
      await updateHead(["update-ref", "HEAD", oid]);
      expect(warnings).toEqual([]);
      expect(events.history).toEqual([]);
    }
    // Ordinary saves still reconcile their changed path without reading unrelated directories.
    const saved = new Promise<void>((resolve) => {
      saveEvent = resolve;
    });
    await h.file("a.ts", "saved with more bytes");
    await saved;
    saveEvent = undefined;
    await reconcile();
    expect(events.history.flat()).toContainEqual({ path: "a.ts", kind: "changed" });
    expect(warnings).toEqual([]);
    unavailable = false;
    await updateHead(["symbolic-ref", "HEAD", "refs/heads/other"]);
    expect(events.history.flat()).toContainEqual({ path: "a.ts", kind: "deleted" });
    events.history.length = 0;
    await updateHead(["update-ref", "--no-deref", "HEAD", first]);
    expect(events.history.flat()).toEqual([{ path: "a.ts", kind: "created" }]);
    expect(warnings).toEqual([]);
  } finally {
    await subscription.dispose();
  }
});
