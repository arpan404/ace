import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { GitError, GitService, isMutationUnavailable } from "./index.ts";
import { git, put, repository, scalar, scratch } from "./test-repo.ts";

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
