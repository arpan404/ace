import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

const service = new GitService();

test("checkpoint ignores nested linked worktrees", async () => {
  const repo = await repository();
  const linked = join(repo, ".claude", "worktrees", "agent-1");
  await git(repo, "worktree", "add", "--quiet", "-b", "agent-1", linked);
  await put(linked, "agent-edit.txt", "the agent's work\n");
  // A separate repository below the checkout is still part of its state.
  const nested = join(repo, "vendor", "lib");
  await git(repo, "init", "--quiet", "--initial-branch=main", nested);
  await git(nested, "config", "user.name", "Test");
  await git(nested, "config", "user.email", "test@example.invalid");
  await git(nested, "commit", "--quiet", "--allow-empty", "-m", "Nested");
  await put(nested, "lib.txt", "nested contents\n");
  await put(repo, "own.txt", "root edit\n");

  const saved = await service.createCheckpoint({ worktree: repo, threadId: "t", label: "c" });

  const files = (await scalar(repo, "ls-tree", "-r", "--name-only", saved.tree)).split("\n");
  expect(files).toContain("own.txt");
  expect(files).toContain("vendor/lib/lib.txt");
  expect(files.filter((path) => path.startsWith(".claude/"))).toEqual([]);

  // Restoring leaves the linked worktree as it is.
  await put(repo, "own.txt", "changed later\n");
  await service.restoreCheckpoint({ worktree: repo, checkpoint: saved.id });
  expect(await readFile(join(repo, "own.txt"), "utf8")).toBe("root edit\n");
  expect(await readFile(join(linked, "agent-edit.txt"), "utf8")).toBe("the agent's work\n");
  expect((await service.listWorktrees(repo)).map((tree) => tree.branch)).toContain("agent-1");
});
