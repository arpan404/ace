import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { workspaceRuntime } from "./index.ts";
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
