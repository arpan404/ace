import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scratch } from "./test-repo.ts";

const service = new GitService({ transportProtocols: ["file"] });

/** A bare remote whose HEAD names `trunk`, added to a repository that never fetched it. */
async function addedRemote(name: string) {
  const work = await repository();
  const directory = await scratch();
  const bare = join(directory, "remote.git");
  await git(directory, "clone", "--quiet", "--bare", "--", work, bare);
  await git(bare, "branch", "--quiet", "trunk");
  await git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");
  await git(work, "remote", "add", name, bare);
  return { work, bare };
}

test("the default branch comes from the remote's HEAD when it was never recorded locally", async () => {
  const { work } = await addedRemote("origin");
  // `git remote add` records no refs/remotes/origin/HEAD, so only the remote can say.
  expect(await service.defaultBranch(work)).not.toBe("trunk");
  expect(
    await service.remoteDefaultBranch({ repo: work, remote: "origin", timeoutMs: 30_000 }),
  ).toBe("trunk");
});

test("the configured remote is asked, not origin", async () => {
  const { work } = await addedRemote("upstream");
  expect(
    await service.remoteDefaultBranch({ repo: work, remote: "upstream", timeoutMs: 30_000 }),
  ).toBe("trunk");
  expect(
    await service.remoteDefaultBranch({ repo: work, remote: "origin", timeoutMs: 30_000 }),
  ).toBeUndefined();
});

test("a recorded remote HEAD answers without contacting the remote", async () => {
  const { work, bare } = await addedRemote("origin");
  await git(work, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  await git(bare, "symbolic-ref", "HEAD", "refs/heads/missing");
  expect(
    await service.remoteDefaultBranch({ repo: work, remote: "origin", timeoutMs: 30_000 }),
  ).toBe("develop");
});

test("an unreachable remote has no answer instead of failing or prompting", async () => {
  const work = await repository();
  await git(work, "remote", "add", "origin", join(await scratch(), "gone.git"));
  expect(
    await service.remoteDefaultBranch({ repo: work, remote: "origin", timeoutMs: 30_000 }),
  ).toBeUndefined();
});
