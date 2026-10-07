import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitService, isMutationUnavailable } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

const service = new GitService();

/** A bare `origin`, a working copy that publishes to it, and a fresh clone of it. */
async function remoteSetup() {
  const publisher = await repository();
  const directory = await scratch();
  const origin = join(directory, "origin.git");
  const clone = join(directory, "clone");
  await git(directory, "clone", "--quiet", "--bare", "--", publisher, origin);
  await git(publisher, "remote", "add", "origin", origin);
  await git(publisher, "fetch", "--quiet", "origin");
  await git(directory, "clone", "--quiet", "--", origin, clone);
  await git(clone, "config", "user.name", "Clone");
  await git(clone, "config", "user.email", "clone@example.invalid");
  const publish = async (branch: string, message: string) => {
    await git(publisher, "switch", "--quiet", "-C", branch);
    await put(publisher, "tracked.txt", `${message}\n`);
    await git(publisher, "commit", "--quiet", "-am", message);
    await git(publisher, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    return scalar(publisher, "rev-parse", "HEAD");
  };
  return { publisher, origin, clone, directory, publish };
}

/** Everything the person owns in a checkout: HEAD, index, working tree and local branches. */
async function checkoutState(repo: string) {
  return {
    head: await readFile(join(repo, ".git", "HEAD"), "utf8"),
    index: await readFile(join(repo, ".git", "index")),
    file: await readFile(join(repo, "tracked.txt"), "utf8"),
    branches: await scalar(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  };
}

test("branch refs show a local branch behind its upstream and branches only the remote has", async () => {
  const { clone, publish } = await remoteSetup();
  await publish("main", "Second");
  await publish("main", "Third");
  await publish("feature/remote-only", "Remote work");
  await service.fetchBranch({ repo: clone, remote: "origin", branch: "main", timeoutMs: 60_000 });
  await service.fetchBranch({
    repo: clone,
    remote: "origin",
    branch: "feature/remote-only",
    timeoutMs: 60_000,
  });
  await git(clone, "branch", "--quiet", "--no-track", "scratch");

  const result = await service.branchRefs(clone);

  expect(result).toEqual({
    defaultBranch: "main",
    truncated: false,
    refs: [
      { name: "main", upstream: "origin/main", ahead: 0, behind: 2 },
      { name: "scratch" },
      { name: "feature/remote-only", remote: "origin" },
      { name: "main", remote: "origin" },
    ],
  });
});

test("fetching a branch moves only its remote-tracking ref, leaving the checkout, other branches and tags alone", async () => {
  const { clone, publisher, publish } = await remoteSetup();
  const newer = await publish("main", "Newer on origin");
  await publish("other", "Other branch");
  await git(publisher, "tag", "v1");
  await git(publisher, "push", "--quiet", "origin", "v1");
  await put(clone, "tracked.txt", "uncommitted edit\n");
  await put(clone, "staged.txt", "staged\n");
  await git(clone, "add", "staged.txt");
  const before = await checkoutState(clone);

  await service.fetchBranch({ repo: clone, remote: "origin", branch: "main", timeoutMs: 60_000 });

  expect(await scalar(clone, "rev-parse", "refs/remotes/origin/main")).toBe(newer);
  expect(await checkoutState(clone)).toEqual(before);
  expect(await scalar(clone, "for-each-ref", "refs/remotes/origin/other", "refs/tags")).toBe("");
});

test("fetching a branch the remote doesn't have fails as not found and changes nothing", async () => {
  const { clone } = await remoteSetup();
  const refs = await scalar(clone, "for-each-ref");

  await expect(
    service.fetchBranch({ repo: clone, remote: "origin", branch: "missing", timeoutMs: 60_000 }),
  ).rejects.toMatchObject({ code: "remote_ref_not_found" });
  expect(await scalar(clone, "for-each-ref")).toBe(refs);
});

test("an unreachable remote fails the fetch as unreachable and the repository stays usable", async () => {
  const { clone, directory } = await remoteSetup();
  await git(clone, "remote", "set-url", "origin", join(directory, "removed.git"));

  const failure = await service
    .fetchBranch({ repo: clone, remote: "origin", branch: "main", timeoutMs: 60_000 })
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: "remote_unreachable" });
  expect(isMutationUnavailable(failure)).toBe(false);
  expect(await service.mutationState(clone)).toEqual({ status: "available", leases: [] });
  const path = join(dirname(clone), "after-unreachable");
  await expect(
    service.createWorktree({ repo: clone, path, baseRef: "origin/main", branch: "ace/after" }),
  ).resolves.toMatchObject({ branch: "ace/after" });
});

test("a fetch that outlives its deadline is stopped without quarantining the repository", async () => {
  const { clone, directory } = await remoteSetup();
  // A transport that never answers, configured the way a person would configure their own ssh.
  const hang = join(directory, "hang.sh");
  await writeFile(hang, "#!/bin/sh\nexec sleep 600\n");
  await chmod(hang, 0o755);
  await git(clone, "config", "core.sshCommand", hang);
  await git(clone, "remote", "set-url", "origin", "ssh://git.example.invalid/repo.git");
  const before = await scalar(clone, "rev-parse", "refs/remotes/origin/main");

  const failure = await service
    .fetchBranch({ repo: clone, remote: "origin", branch: "main", timeoutMs: 500 })
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: "git_timeout" });
  expect(isMutationUnavailable(failure)).toBe(false);
  expect(await service.mutationState(clone)).toEqual({ status: "available", leases: [] });
  expect(await scalar(clone, "rev-parse", "refs/remotes/origin/main")).toBe(before);
  await expect(service.status(clone)).resolves.toMatchObject({ conflicted: [] });
  const path = join(dirname(clone), "after-timeout");
  await expect(
    service.createWorktree({ repo: clone, path, baseRef: before, branch: "ace/after-timeout" }),
  ).resolves.toMatchObject({ head: before });
});

test("branch heads resolve only literal branch names, locally or on a remote", async () => {
  const { clone, publish } = await remoteSetup();
  const local = await scalar(clone, "rev-parse", "HEAD");
  const remote = await publish("main", "Newer");
  await service.fetchBranch({ repo: clone, remote: "origin", branch: "main", timeoutMs: 60_000 });

  expect(await service.branchHead({ repo: clone, branch: "main" })).toBe(local);
  expect(await service.branchHead({ repo: clone, branch: "main", remote: "origin" })).toBe(remote);
  expect(await service.branchHead({ repo: clone, branch: "absent" })).toBeUndefined();
  await expect(service.branchHead({ repo: clone, branch: "main~1" })).rejects.toMatchObject({
    code: "invalid_ref",
  });
});
