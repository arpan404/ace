import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, put, repository, scalar } from "./test-repo.ts";

/** A checkout and a bare remote it has pushed `main` to, plus a collaborator's clone. */
async function published() {
  const repo = await repository();
  const home = dirname(repo);
  const remote = join(home, "remote.git");
  await git(repo, "branch", "-M", "main");
  await git(repo, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "--set-upstream", "origin", "main");
  const collaborator = join(home, "collaborator");
  await git(home, "clone", "--", remote, collaborator);
  return { repo, remote, collaborator };
}

async function commit(repo: string, content: string) {
  await put(repo, "tracked.txt", content);
  await git(
    repo,
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-qam",
    content,
  );
  return scalar(repo, "rev-parse", "HEAD");
}

test("a push behind the remote is refused with the tracked remote head, and a lease to it replaces the branch", async () => {
  const { repo, remote, collaborator } = await published();
  const service = new GitService({ transportProtocols: ["file"] });
  try {
    await commit(collaborator, "collaborator\n");
    await git(collaborator, "push", "origin", "main");
    await git(repo, "fetch", "origin");
    const seen = await scalar(repo, "rev-parse", "refs/remotes/origin/main");
    const mine = await commit(repo, "mine\n");
    await expect(service.push({ worktree: repo, remote: "origin" })).rejects.toMatchObject({
      code: "push_rejected",
      details: { remoteHead: seen },
    });
    expect(await scalar(remote, "rev-parse", "refs/heads/main")).toBe(seen);
    await service.push({ worktree: repo, remote: "origin", force: { lease: seen } });
    expect(await scalar(remote, "rev-parse", "refs/heads/main")).toBe(mine);
  } finally {
    await service.close();
  }
});

test("a lease to a revision the remote has moved past is refused and leaves the remote alone", async () => {
  const { repo, remote, collaborator } = await published();
  const service = new GitService({ transportProtocols: ["file"] });
  try {
    const seen = await scalar(repo, "rev-parse", "refs/remotes/origin/main");
    // The collaborator pushes after the person last looked; their tracking ref is stale.
    const theirs = await commit(collaborator, "collaborator\n");
    await git(collaborator, "push", "origin", "main");
    await commit(repo, "mine\n");
    await expect(
      service.push({ worktree: repo, remote: "origin", force: { lease: seen } }),
    ).rejects.toMatchObject({ code: "push_lease_stale" });
    expect(await scalar(remote, "rev-parse", "refs/heads/main")).toBe(theirs);
  } finally {
    await service.close();
  }
});

test("a remote's branch protection refusal is told apart from a rejected push", async () => {
  const { repo, remote } = await published();
  const service = new GitService({ transportProtocols: ["file"] });
  try {
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(
      hook,
      "#!/bin/sh\necho 'GH006: Protected branch update failed for refs/heads/main.' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    await commit(repo, "mine\n");
    await expect(
      service.asPerson(() => service.push({ worktree: repo, remote: "origin" })),
    ).rejects.toMatchObject({ code: "push_protected" });
  } finally {
    await service.close();
  }
});

test("a pull request checkout on its own local branch pushes to the PR's head branch and tracks it", async () => {
  const { repo, remote } = await published();
  const service = new GitService({ transportProtocols: ["file"] });
  try {
    await git(repo, "push", "origin", "main:refs/heads/feature");
    await git(repo, "switch", "-c", "ace/0123456789abcdef", "--no-track", "origin/feature");
    const head = await commit(repo, "review fix\n");
    await service.push({ worktree: repo, remote: "origin", destination: "feature" });
    expect(await scalar(remote, "rev-parse", "refs/heads/feature")).toBe(head);
    expect(await scalar(remote, "for-each-ref", "--format=%(refname)", "refs/heads/ace")).toBe("");
    expect(await scalar(repo, "config", "branch.ace/0123456789abcdef.merge")).toBe(
      "refs/heads/feature",
    );
    await expect(
      service.push({ worktree: repo, remote: "origin", destination: "bad..name" }),
    ).rejects.toMatchObject({ code: "invalid_ref" });
  } finally {
    await service.close();
  }
});
