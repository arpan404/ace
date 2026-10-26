import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { test } from "vitest";
import { git, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

const status = (path: string) => git(path, "status", "--porcelain", "--untracked-files=all");

/** The target's own clone of the same origin, registered there as a project. */
async function cloneThere(m: Awaited<ReturnType<typeof transferMachines>>, origin: string) {
  const path = join(m.targetRoot, "app-there");
  await git(m.targetRoot, "clone", `file://${origin}`, path);
  return { path, workspaceId: await m.addProject(m.target, path) };
}

it("reuses the target's project for the same origin, and never disturbs its busy checkout", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await cloneThere(m, origin);
  // There: someone's own feature branch, and an edit in progress on main.
  await git(there.path, "branch", "feature");
  await writeFile(join(there.path, "README.md"), "their edit\n");
  const theirs = await status(there.path);
  const theirFeature = await git(there.path, "rev-parse", "feature");
  // Here: a different feature branch, with a commit and an uncommitted file.
  await git(path, "switch", "-c", "feature");
  await writeFile(join(path, "mine.txt"), "mine\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "mine");
  await writeFile(join(path, "draft.txt"), "draft\n");
  const workspaceId = await m.addProject(m.source, path);

  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "remote" });
  const landed = transfer.result;
  expect(landed?.workspaceId).toBe(there.workspaceId);
  expect(landed?.branch).toBe("feature-from-macbook");
  // The branch got its own folder beside the project, with the uncommitted file there.
  expect(landed?.path).not.toBe(there.path);
  expect(await git(landed?.path ?? "", "log", "-1", "--format=%s")).toBe("mine");
  expect(await status(landed?.path ?? "")).toBe("?? draft.txt");
  // Their checkout and their branch are as they were.
  expect(await status(there.path)).toBe(theirs);
  expect(await git(there.path, "branch", "--show-current")).toBe("main");
  expect(await git(there.path, "rev-parse", "feature")).toBe(theirFeature);
});

it("brings a clean checkout on the same branch forward, with the changes uncommitted in it", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await cloneThere(m, origin);
  await writeFile(join(path, "next.txt"), "next\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "next");
  await writeFile(join(path, "README.md"), "edited\n");
  const workspaceId = await m.addProject(m.source, path);

  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const transfer = await m.settled();
  expect(transfer.result).toMatchObject({
    workspaceId: there.workspaceId,
    path: there.path,
    branch: "main",
  });
  expect(await git(there.path, "log", "-1", "--format=%s")).toBe("next");
  expect(await status(there.path)).toBe(" M README.md");
});

it("sends the whole repository when the target can't clone its origin", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await git(path, "remote", "set-url", "origin", "https://example.invalid/app.git");
  await writeFile(join(path, "new.txt"), "new\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "new");
  const workspaceId = await m.addProject(m.source, path);

  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "bundle" });
  const landed = transfer.result?.path ?? "";
  expect(await git(landed, "log", "--format=%s")).toBe("new\nfirst");
  expect(await readFile(join(landed, "new.txt"), "utf8")).toBe("new\n");
  expect(await git(landed, "remote", "get-url", "origin")).toBe("https://example.invalid/app.git");
  expect(await git(landed, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
  expect(m.here.progress().map((entry) => entry.method)).toContain("remote");
});

it("lands a detached HEAD at its exact commit, on a branch named for it", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  // A commit no branch holds: only the detached HEAD reaches it.
  await git(path, "switch", "--detach");
  await writeFile(join(path, "loose.txt"), "loose\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "loose");
  const head = await git(path, "rev-parse", "HEAD");
  const workspaceId = await m.addProject(m.source, path);

  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  const transfer = await m.settled();
  expect(transfer.phase).toBe("completed");
  const landed = transfer.result?.path ?? "";
  expect(transfer.result?.branch).toBe(`detached-${head.slice(0, 12)}`);
  expect(await git(landed, "rev-parse", "HEAD")).toBe(head);
  expect(await git(landed, "branch", "--show-current")).toBe(`detached-${head.slice(0, 12)}`);
  // Nothing of the transfer stays pinned on either machine.
  expect(await git(path, "for-each-ref", "refs/ace")).toBe("");
  expect(await git(landed, "for-each-ref", "refs/ace")).toBe("");
});

it("lands beside a dirty checkout already at the same commit, on a branch its worktree can use", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await cloneThere(m, origin);
  await writeFile(join(there.path, "README.md"), "their edit\n");
  const theirs = await status(there.path);
  await writeFile(join(path, "draft.txt"), "draft\n");
  const workspaceId = await m.addProject(m.source, path);

  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({
    phase: "completed",
    method: "remote",
    result: { workspaceId: there.workspaceId, branch: "main-from-macbook" },
  });
  const landed = transfer.result?.path ?? "";
  expect(landed).not.toBe(there.path);
  expect(await status(landed)).toBe("?? draft.txt");
  expect(await status(there.path)).toBe(theirs);
});

test.runIf(process.platform === "win32")(
  "on Windows, a repository sent whole lands with its files as the person's own Git there writes them",
  async () => {
    const m = await transferMachines();
    const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
    await git(path, "remote", "set-url", "origin", "https://example.invalid/app.git");
    await writeFile(join(path, "new.txt"), "new\n");
    await git(path, "add", "-A");
    await git(path, "commit", "-m", "new");
    const workspaceId = await m.addProject(m.source, path);

    await m.here.command({
      type: "workspace.transfer",
      workspaceId,
      hostId: m.targetHostId,
      includeChanges: false,
    });
    const transfer = await m.settled();
    expect(transfer).toMatchObject({ phase: "completed", method: "bundle" });
    const landed = transfer.result?.path ?? "";
    expect(await git(landed, "log", "--format=%s")).toBe("new\nfirst");
    // Their own clone of the same commit: its line endings follow their core.autocrlf.
    const own = join(m.targetRoot, "own");
    await git(m.targetRoot, "clone", "--quiet", path, own);
    expect(await readFile(join(landed, "new.txt"))).toEqual(await readFile(join(own, "new.txt")));
    expect(await status(landed)).toBe("");
    expect(await git(landed, "remote", "get-url", "origin")).toBe(
      "https://example.invalid/app.git",
    );
    expect(await git(landed, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
  },
);
