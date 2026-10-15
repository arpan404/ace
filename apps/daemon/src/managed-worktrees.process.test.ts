import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "@ace/git";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { ManagedWorktrees } from "./managed-worktrees.ts";
import { Store } from "./store.ts";
import { git } from "./test-git.ts";

test.each([
  ["absolute", "false"],
  ["relative", "true"],
])("a managed worktree whose Git links are %s paths still verifies", async (_kind, relative) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-managed-")));
  const store = new Store(join(home, "events.sqlite"));
  try {
    const repo = join(home, "repo");
    await mkdir(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(
      repo,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    );
    await mkdir(join(home, "worktrees"));
    const path = join(home, "worktrees", "linked");
    git(
      repo,
      "-c",
      `worktree.useRelativePaths=${relative}`,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "linked",
      path,
    );
    const managed = new ManagedWorktrees(store, home);
    await managed.created(new GitService(), repo, path, ThreadId.parse("thread"), 1);
    expect(managed.verify(repo, path)).toMatchObject({ path, repo });
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
