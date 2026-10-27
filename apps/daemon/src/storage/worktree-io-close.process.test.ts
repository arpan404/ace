import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WorktreeIO } from "./worktree-io.ts";
import { git } from "./worktree-test-support.ts";

test("closing the worktree worker cancels a backup push the remote never answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktree-io-close-"));
  // A remote that takes the push's first request and never replies.
  const reached = Promise.withResolvers<void>();
  const server = createServer(() => reached.resolve());
  const listening = Promise.withResolvers<number>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    listening.resolve(address.port);
  });
  const port = await listening.promise;
  const repo = join(root, "project");
  const worktree = join(root, "topic");
  const worktrees = new WorktreeIO();
  try {
    await git(root, "init", "-b", "main", repo);
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "user.email", "test@ace.local");
    await writeFile(join(repo, "file.txt"), "original\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "Initial");
    await git(repo, "remote", "add", "origin", `http://127.0.0.1:${port}/project.git`);
    await git(repo, "worktree", "add", "-b", "topic", worktree);
    await writeFile(join(worktree, "file.txt"), "settled work\n");

    const backup = worktrees.backupWorktree(repo, worktree).then(
      () => "pushed",
      () => "cancelled",
    );
    await reached.promise;
    const closedAt = performance.now();
    await worktrees.close();
    expect(await backup).toBe("cancelled");
    expect(performance.now() - closedAt).toBeLessThan(3000);
    // The settled work was committed before the push, so nothing is lost.
    expect(await git(worktree, "log", "-1", "--format=%s")).toBe("Back up settled worktree");
  } finally {
    await worktrees.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
