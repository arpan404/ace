import { join } from "node:path";
import { expect, test } from "vitest";
import { GitService } from "./index.ts";
import { git, repository, scalar, scratch } from "./test-repo.ts";

/** A checkout and a bare origin holding `model` and `api` at the reviewed revisions. */
async function stackRemote() {
  const root = await repository();
  const remote = join(await scratch(), "remote.git");
  await git(root, "init", "--bare", remote);
  await git(root, "remote", "add", "origin", remote);
  await git(root, "branch", "model");
  await git(root, "branch", "api");
  await git(root, "push", "--quiet", "origin", "model", "api");
  const reviewed = await scalar(root, "rev-parse", "model");
  await git(root, "checkout", "--quiet", "model");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "Model rebased");
  await git(root, "checkout", "--quiet", "api");
  await git(root, "reset", "--quiet", "--hard", "model");
  await git(root, "commit", "--quiet", "--allow-empty", "-m", "API rebased");
  return {
    root,
    remote,
    reviewed,
    model: await scalar(root, "rev-parse", "model"),
    api: await scalar(root, "rev-parse", "api"),
  };
}

test("leased branches move together when the remote still holds every reviewed revision", async () => {
  const f = await stackRemote();
  const service = new GitService({ transportProtocols: ["file"] });
  let dispatched = 0;
  try {
    const result = await service.pushLeased({
      worktree: f.root,
      remote: "origin",
      updates: [
        { ref: "refs/heads/model", lease: f.reviewed, target: f.model },
        { ref: "refs/heads/api", lease: f.reviewed, target: f.api },
      ],
      beforeDispatch: () => dispatched++,
    });
    expect(result.exitCode).toBe(0);
    expect(result.refs.map((ref) => [ref.ref, ref.status]).toSorted()).toEqual([
      ["refs/heads/api", "updated"],
      ["refs/heads/model", "updated"],
    ]);
    expect(dispatched).toBe(1);
    expect(await scalar(f.remote, "rev-parse", "model", "api")).toBe(`${f.model}\n${f.api}`);
  } finally {
    await service.close();
  }
});

test("a collaborator commit on one leased branch rejects the whole push and moves no branch", async () => {
  const f = await stackRemote();
  const collaborator = join(await scratch(), "collaborator");
  await git(f.root, "clone", "--quiet", "--branch", "api", f.remote, collaborator);
  await git(collaborator, "commit", "--quiet", "--allow-empty", "-m", "Collaborator fix");
  await git(collaborator, "push", "--quiet", "origin", "api");
  const theirs = await scalar(collaborator, "rev-parse", "HEAD");
  const service = new GitService({ transportProtocols: ["file"] });
  try {
    const result = await service.pushLeased({
      worktree: f.root,
      remote: "origin",
      updates: [
        { ref: "refs/heads/model", lease: f.reviewed, target: f.model },
        { ref: "refs/heads/api", lease: f.reviewed, target: f.api },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.refs.every((ref) => ref.status === "rejected")).toBe(true);
    expect(result.refs.find((ref) => ref.ref === "refs/heads/api")?.reason).toBe("stale info");
    expect(await scalar(f.remote, "rev-parse", "model", "api")).toBe(`${f.reviewed}\n${theirs}`);
  } finally {
    await service.close();
  }
});

test("a revision missing from the checkout is refused before Git contacts the remote", async () => {
  const f = await stackRemote();
  const service = new GitService({ transportProtocols: ["file"] });
  let dispatched = false;
  try {
    await expect(
      service.pushLeased({
        worktree: f.root,
        remote: "origin",
        updates: [{ ref: "refs/heads/model", lease: f.reviewed, target: "e".repeat(40) }],
        beforeDispatch: () => {
          dispatched = true;
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_ref" });
    expect(dispatched).toBe(false);
    expect(await scalar(f.remote, "rev-parse", "model")).toBe(f.reviewed);
  } finally {
    await service.close();
  }
});
