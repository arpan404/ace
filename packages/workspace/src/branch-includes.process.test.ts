import { join } from "node:path";
import { expect, test } from "vitest";
import { batches, exec, fixture } from "./test-support.ts";

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
      `[core]\nexcludesFile = ${join(second.service.root, "rules")}\n`,
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
