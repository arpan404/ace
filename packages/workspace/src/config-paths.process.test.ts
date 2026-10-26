import { watch as nativeWatch } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { filesystem, workspaceRuntime } from "./index.ts";
import { batches, exec, fixture } from "./test-support.ts";

/** Git config text treats "\\" as an escape, so Windows paths written into it use "/". */
function gitPath(path: string): string {
  return path.replaceAll("\\", "/");
}

// The shared include and branch cases write native paths into Git config text, which Git on
// Windows rejects as bad escapes. These are the same cases with paths as Windows users write them.
describe.runIf(process.platform === "win32")("Windows Git config sources", () => {
  test.each([
    "empty relative",
    "missing relative",
    "empty absolute",
    "empty conditional",
    "empty home",
  ])("%s included config changes invalidate visibility through native delivery", async (kind) => {
    const peer = await fixture();
    const h = await fixture(
      {
        runtime: {
          environment: { ...workspaceRuntime().environment, HOME: peer.service.root },
        },
      },
      true,
    );
    const extra = join(peer.service.root, "nested/extra.conf");
    const rules = join(peer.service.root, "rules");
    const target =
      kind === "empty absolute"
        ? gitPath(extra)
        : kind === "empty home"
          ? "~/nested/extra.conf"
          : "nested/extra.conf";
    // A trailing slash would match only paths inside .git, never the repository's own gitdir.
    const section =
      kind === "empty conditional"
        ? `[includeIf "gitdir:${gitPath(h.service.root)}/.git"]`
        : "[include]";
    await peer.file("declaring.conf", `${section}\npath = ${target}\n`);
    if (kind !== "missing relative") await peer.file("nested/extra.conf", "");
    await peer.file("rules", "a.ts\n");
    await h.file("a.ts", "untracked");
    await exec("git", [
      "-C",
      h.root,
      "config",
      "--add",
      "include.path",
      join(peer.service.root, "declaring.conf"),
    ]);
    const events = batches();
    const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
    try {
      expect(subscription.mode).toBe("native");
      const hidden = events.next("a.ts", "deleted");
      await peer.file("nested/extra.conf", `[core]\nexcludesFile = ${gitPath(rules)}\n`);
      expect(await hidden).toContainEqual({ path: "a.ts", kind: "deleted" });
      const restored = events.next("a.ts", "created");
      await peer.file("rules", "");
      expect(await restored).toContainEqual({ path: "a.ts", kind: "created" });
      expect(events.history.flat().every((change) => change.path === "a.ts")).toBe(true);
    } finally {
      await subscription.dispose();
    }
  });

  test.each(["repository", "linked worktree"])(
    "branch-dependent excludes follow the %s HEAD through native delivery",
    async (location) => {
      const repository = await fixture({}, true);
      await exec("git", ["-C", repository.root, "symbolic-ref", "HEAD", "refs/heads/main"]);
      await repository.file("seed.txt", "tracked");
      await exec("git", ["-C", repository.root, "add", "seed.txt"]);
      await exec("git", [
        "-C",
        repository.root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@ace.local",
        "commit",
        "-m",
        "Seed branches",
      ]);
      await exec("git", ["-C", repository.root, "branch", "other"]);
      const h = location === "repository" ? repository : await fixture();
      if (location === "linked worktree") {
        await exec("git", ["-C", repository.root, "worktree", "add", "-b", "base", h.root]);
      } else {
        await exec("git", ["-C", h.root, "branch", "base"]);
        await exec("git", ["-C", h.root, "symbolic-ref", "HEAD", "refs/heads/base"]);
      }
      const detached = (await exec("git", ["-C", h.root, "rev-parse", "HEAD"])).stdout.trim();
      const first = await fixture();
      const second = await fixture();
      await first.file("rules", "");
      await second.file("rules", "a.ts\n");
      await second.file(
        "branch.conf",
        `[core]\nexcludesFile = ${gitPath(join(second.service.root, "rules"))}\n`,
      );
      await h.file("a.ts", "untracked");
      await exec("git", [
        "-C",
        h.root,
        "config",
        "core.excludesFile",
        join(first.service.root, "rules"),
      ]);
      await exec("git", [
        "-C",
        h.root,
        "config",
        "--add",
        "includeIf.onbranch:other.path",
        join(second.service.root, "branch.conf"),
      ]);
      const events = batches();
      const subscription = await h.service.watch({ onChange: events.onChange, onWarning() {} });
      try {
        expect(subscription.mode).toBe("native");
        const hidden = events.next("a.ts", "deleted");
        await exec("git", ["-C", h.root, "symbolic-ref", "HEAD", "refs/heads/other"]);
        expect(await hidden).toContainEqual({ path: "a.ts", kind: "deleted" });
        // Activation must also subscribe to B, not just update its current visibility.
        const restored = events.next("a.ts", "created");
        await second.file("rules", "");
        expect(await restored).toContainEqual({ path: "a.ts", kind: "created" });
        const hiddenAgain = events.next("a.ts", "deleted");
        await second.file("rules", "a.ts\n");
        expect(await hiddenAgain).toContainEqual({ path: "a.ts", kind: "deleted" });
        const deactivated = events.next("a.ts", "created");
        await exec("git", ["-C", h.root, "update-ref", "--no-deref", "HEAD", detached]);
        expect(await deactivated).toContainEqual({ path: "a.ts", kind: "created" });
        expect(events.history.flat().every((change) => change.path === "a.ts")).toBe(true);
      } finally {
        await subscription.dispose();
      }
    },
  );
});

// The same HEAD case as head-reconciliation.process.test.ts, with a "/" path in config text.
test.runIf(process.platform === "win32")(
  "detachment and repeated detached HEAD updates leave unrelated inventory untouched when ignores stay the same",
  async () => {
    const timers = new Set<() => void | Promise<void>>();
    let scheduled: (() => void) | undefined;
    let headEvent: (() => void) | undefined;
    let saveEvent: (() => void) | undefined;
    let unavailable = false;
    let workspace: string | undefined;
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
              // Absolute, so it matches a recursive root watch and Linux's per-directory ones.
              const path = filename === null ? undefined : join(root, filename);
              if (!workspace || !path) return;
              if (
                path === join(workspace, ".git", "HEAD") ||
                path === join(workspace, ".git", "HEAD.lock")
              )
                headEvent?.();
              if (path === join(workspace, "a.ts")) saveEvent?.();
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
    workspace = h.service.root;
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
    await peer.file(
      "branch.conf",
      `[core]\nexcludesFile = ${gitPath(join(peer.service.root, "rules"))}\n`,
    );
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
  },
);
