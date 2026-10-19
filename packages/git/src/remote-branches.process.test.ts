import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { testGitEnvironment } from "@ace/provider-kit/test-isolation";
import { GitError, GitService, isMutationUnavailable } from "./index.ts";
import { execute, git, put, repository, scalar, scratch } from "./test-repo.ts";

const service = new GitService({ transportProtocols: ["file"] });

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

/** A commit on top of HEAD whose committer date is `date`. */
async function commitAt(repo: string, date: string): Promise<string> {
  const env = { ...testGitEnvironment(), GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  const { stdout } = await execute(
    "git",
    ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", date],
    {
      cwd: repo,
      env,
    },
  );
  return stdout.trim();
}

/** Point many refs at once, as a repository full of agent branches would have them. */
async function pointRefs(repo: string, refs: Record<string, string>) {
  const child = spawn("git", ["update-ref", "--stdin"], {
    cwd: repo,
    env: testGitEnvironment(),
    stdio: ["pipe", "ignore", "inherit"],
  });
  child.stdin.end(
    Object.entries(refs)
      .map(([ref, commit]) => `update ${ref} ${commit}\n`)
      .join(""),
  );
  const [code] = await once(child, "close");
  expect(code).toBe(0);
}

/**
 * A clone with far more branches than one listing carries: 1,100 local and 1,100 remote ones
 * committed in 2020, origin's `main` at an older commit (2001), and one local and one remote
 * branch committed in 2030 whose names sort last.
 */
async function crowdedClone() {
  const { clone } = await remoteSetup();
  const older = await commitAt(clone, "2001-01-01T00:00:00Z");
  const old = await commitAt(clone, "2020-01-01T00:00:00Z");
  const newest = await commitAt(clone, "2030-01-01T00:00:00Z");
  const refs: Record<string, string> = {
    "refs/remotes/origin/main": older,
    "refs/heads/zz-newest": newest,
    "refs/remotes/origin/zz-newest": newest,
  };
  for (let index = 0; index < 1100; index += 1) {
    const name = `ace/agent-${String(index).padStart(4, "0")}`;
    refs[`refs/heads/${name}`] = old;
    refs[`refs/remotes/origin/${name}`] = old;
  }
  await pointRefs(clone, refs);
  return clone;
}

test("the default branch is offered locally and from origin however many branches the repository has", async () => {
  const clone = await crowdedClone();

  const result = await service.branchRefs(clone);

  expect(result.defaultBranch).toBe("main");
  expect(result.refs).toContainEqual({ name: "main", remote: "origin" });
  expect(result.refs).toContainEqual(
    expect.objectContaining({ name: "main", upstream: "origin/main" }),
  );
  expect(result.refs).toHaveLength(1000);
  expect(result.truncated).toBe(true);
});

test("with more branches than fit, local and remote branches share the room and the newest are kept", async () => {
  const clone = await crowdedClone();

  const { refs } = await service.branchRefs(clone);

  const remote = refs.filter((ref) => ref.remote);
  expect(remote.length).toBe(500);
  expect(refs.length - remote.length).toBe(500);
  expect(refs).toContainEqual({ name: "zz-newest" });
  expect(refs).toContainEqual({ name: "zz-newest", remote: "origin" });
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

test("a fetch deadline preserves its cleanup receipt without holding a working-tree mutation lease", async () => {
  const { clone } = await remoteSetup();
  const requested = Promise.withResolvers<void>();
  const server = createServer(() => {
    requested.resolve();
  });
  const fetcher = new GitService({
    transportProtocols: ["http"],
    credentialHelperLookup: async () => [],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  try {
    await git(clone, "remote", "set-url", "origin", `http://127.0.0.1:${address.port}/repo.git`);
    const before = await scalar(clone, "rev-parse", "refs/remotes/origin/main");
    const operation = fetcher
      .fetchBranch({ repo: clone, remote: "origin", branch: "main", timeoutMs: 500 })
      .catch((error: unknown) => error);
    await Promise.race([
      requested.promise,
      operation.then(() => {
        throw new Error("Fetch ended before reaching the remote");
      }),
    ]);
    const failure = await operation;
    expect(failure).toMatchObject({ code: "git_timeout" });
    expect(isMutationUnavailable(failure)).toBe(true);
    if (!(failure instanceof GitError) || !failure.cleanup)
      throw new Error("Missing fetch cleanup receipt");
    expect(await failure.cleanup.settled).toMatchObject({ status: "unconfirmed" });
    expect(await fetcher.mutationState(clone)).toEqual({ status: "available", leases: [] });
    expect(await scalar(clone, "rev-parse", "refs/remotes/origin/main")).toBe(before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fetcher.close();
  }
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

test("fetching a PR head keeps staged and dirty work, ordinary refs and FETCH_HEAD unchanged", async () => {
  const { clone, publisher } = await remoteSetup();
  await git(publisher, "commit", "--allow-empty", "-m", "Fork PR commit");
  const head = await scalar(publisher, "rev-parse", "HEAD");
  await git(publisher, "push", "origin", "HEAD:refs/pull/7/head");
  await put(clone, "tracked.txt", "Personal dirty work\n");
  await put(clone, "staged.txt", "Staged work\n");
  await git(clone, "add", "staged.txt");
  await writeFile(join(clone, ".git", "FETCH_HEAD"), "person's prior fetch\n");
  const before = await checkoutState(clone);
  const refs = await scalar(clone, "for-each-ref", "refs/remotes", "refs/tags");
  expect(
    await service.fetchPrHead({ repo: clone, remote: "origin", number: 7, timeoutMs: 60_000 }),
  ).toBe(head);
  expect(await checkoutState(clone)).toEqual(before);
  expect(await scalar(clone, "for-each-ref", "refs/remotes", "refs/tags")).toBe(refs);
  expect(await readFile(join(clone, ".git", "FETCH_HEAD"), "utf8")).toBe("person's prior fetch\n");
});

test("a missing PR ref fails even when an older private PR head is cached", async () => {
  const { clone, publisher, origin } = await remoteSetup();
  await git(publisher, "push", "origin", "HEAD:refs/pull/7/head");
  await service.fetchPrHead({ repo: clone, remote: "origin", number: 7, timeoutMs: 60_000 });
  const before = await checkoutState(clone);
  await git(origin, "update-ref", "-d", "refs/pull/7/head");
  await expect(
    service.fetchPrHead({ repo: clone, remote: "origin", number: 7, timeoutMs: 60_000 }),
  ).rejects.toMatchObject({ code: "remote_ref_not_found" });
  expect(await checkoutState(clone)).toEqual(before);
});
