import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { GitService } from "./index.ts";
import { git, proxyGit, put, repository, scalar, scratch } from "./test-repo.ts";

const service = new GitService({ transportProtocols: ["file"] });

/** A checkout pushing `main` to a bare origin that already has it. */
async function published() {
  const root = await repository();
  const remote = join(await scratch(), "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(root, "remote", "add", "origin", remote);
  await git(root, "push", "--quiet", "origin", "main");
  return { root, remote };
}

test("a branch already checked out in another worktree fails as branch_checked_out with what Git said", async () => {
  const repo = await repository();
  const failure = service.createWorktree({
    repo,
    path: join(dirname(repo), "second"),
    baseRef: "HEAD",
    branch: "main",
    reuseBranch: true,
  });
  await expect(failure).rejects.toMatchObject({
    code: "branch_checked_out",
    details: {
      stderr: expect.stringMatching(/'main' is already (used by worktree|checked out) at/),
    },
  });
});

test("a worktree path that already exists fails as path_exists", async () => {
  const repo = await repository();
  const path = join(dirname(repo), "occupied");
  await put(path, "keep.txt", "mine\n");
  await expect(
    service.createWorktree({ repo, path, baseRef: "HEAD", branch: "fresh" }),
  ).rejects.toMatchObject({
    code: "path_exists",
    details: { stderr: expect.stringContaining("already exists") },
  });
  expect(await service.branchHead({ repo, branch: "fresh" })).toBeUndefined();
});

test.each([
  ["ace", "ace/1f2e3d", "ace"],
  ["ace/1f2e3d", "ace", "ace/1f2e3d"],
])(
  "with branch %s present, a worktree on branch %s fails as ref_conflict naming it",
  async (existing, wanted, conflictsWith) => {
    const repo = await repository();
    await git(repo, "branch", existing);
    await expect(
      service.createWorktree({
        repo,
        path: join(dirname(repo), "conflicted"),
        baseRef: "HEAD",
        branch: wanted,
      }),
    ).rejects.toMatchObject({ code: "ref_conflict", details: { conflictsWith } });
  },
);

test("a worktree from a repository with no commits fails as unborn_head", async () => {
  const repo = join(await scratch(), "empty");
  await mkdir(repo);
  await git(repo, "init", "--quiet", "--initial-branch=main");
  await expect(
    service.createWorktree({
      repo,
      path: join(dirname(repo), "linked"),
      baseRef: "HEAD",
      branch: "first",
    }),
  ).rejects.toMatchObject({ code: "unborn_head" });
});

test("a commit without an author name fails as identity_missing", async () => {
  const root = await repository();
  await git(root, "config", "user.name", "");
  await put(root, "tracked.txt", "edited\n");
  await expect(
    service.commit({
      worktree: root,
      expectedHead: await scalar(root, "rev-parse", "HEAD"),
      message: "No author",
    }),
  ).rejects.toMatchObject({
    code: "identity_missing",
    details: { stderr: expect.stringContaining("ident") },
  });
});

test("a commit with no changes fails as nothing_to_commit", async () => {
  const root = await repository();
  await expect(
    service.commit({
      worktree: root,
      expectedHead: await scalar(root, "rev-parse", "HEAD"),
      message: "Nothing",
    }),
  ).rejects.toMatchObject({ code: "nothing_to_commit" });
});

test("a push the remote refuses as non-fast-forward fails as push_rejected", async () => {
  const { root, remote } = await published();
  const collaborator = join(await scratch(), "collaborator");
  await git(root, "clone", "--quiet", remote, collaborator);
  await git(collaborator, "commit", "--quiet", "--allow-empty", "-m", "Theirs");
  await git(collaborator, "push", "--quiet", "origin", "main");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "Ours");
  await expect(service.push({ worktree: root, remote: "origin" })).rejects.toMatchObject({
    code: "push_rejected",
    details: { stderr: expect.stringContaining("[rejected]") },
  });
});

test("a remote's branch protection fails as protected_branch, not as a local hook failure", async () => {
  const { root, remote } = await published();
  const hook = join(remote, "hooks", "pre-receive");
  // What GitHub prints for a protected branch, from a real server-side hook.
  await put(
    remote,
    "hooks/pre-receive",
    "#!/bin/sh\necho 'error: GH006: Protected branch update failed for refs/heads/main.' >&2\nexit 1\n",
  );
  await chmod(hook, 0o755);
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "Direct to main");
  await expect(service.push({ worktree: root, remote: "origin" })).rejects.toMatchObject({
    code: "protected_branch",
    details: { stderr: expect.stringContaining("GH006") },
  });
});

test("a failed command keeps only a bounded, redacted tail of its stderr", async () => {
  const root = await repository();
  await git(root, "remote", "add", "origin", "https://example.org/repo");
  const said = `fatal: unable to access https://bob:ghp_0123456789abcdefghijklmnopqrstuvwxyzAB@example.org/repo/: denied\\n`;
  // Far more stderr than is kept, written synchronously so it all reaches the pipe before exit.
  const binary = await proxyGit(
    `if (args.includes('push')) { for (let i = 0; i < 64; i++) fs.writeSync(2, "x".repeat(1024) + "\\n"); fs.writeSync(2, "${said}"); process.exit(1); }`,
  );
  const failure = await new GitService({ gitBinary: binary })
    .push({ worktree: root, remote: "origin" })
    .catch((error: unknown) => error);
  const stderr = z.object({ details: z.object({ stderr: z.string() }) }).parse(failure)
    .details.stderr;
  expect(stderr).toContain("fatal: unable to access https://bob:");
  expect(stderr).not.toContain("ghp_0123456789");
  expect(stderr.length).toBeLessThanOrEqual(4096);
});
