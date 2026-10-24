import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { git, repositoryWithOrigin, transferMachines } from "./transfer-test-support.ts";

const binary = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]);

/** A checkout's uncommitted state, as `git status` reports it. */
const status = (path: string) => git(path, "status", "--porcelain", "--untracked-files=all");

it("opens a project on another machine on the same branch, uncommitted changes still uncommitted there", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await git(path, "switch", "-c", "feature");
  await writeFile(join(path, "feature.txt"), "committed here only\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "feature work");
  // Uncommitted: an edit, a deletion, a binary file and an untracked file; an ignored one stays.
  await writeFile(join(path, "README.md"), "hello, edited\n");
  await rm(join(path, "gone.txt"));
  await writeFile(join(path, "image.bin"), binary);
  await writeFile(join(path, ".gitignore"), "secret.env\n");
  await writeFile(join(path, "secret.env"), "TOKEN=1\n");
  const before = await status(path);
  const workspaceId = await m.addProject(m.source, path);

  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  expect(receipt.ok).toBe(true);
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "remote", kind: "project" });
  const landed = transfer.result;
  if (!landed) throw new Error("No result");
  expect(landed.branch).toBe("feature");

  // There: a registered project, on the branch, with the changes uncommitted and the ignored file
  // left behind.
  expect(m.target.daemon.store.getWorkspacePath(landed.workspaceId)).toBe(landed.path);
  expect(await git(landed.path, "branch", "--show-current")).toBe("feature");
  expect(await git(landed.path, "log", "-1", "--format=%s")).toBe("feature work");
  expect(await readFile(join(landed.path, "README.md"), "utf8")).toBe("hello, edited\n");
  expect(await readFile(join(landed.path, "image.bin"))).toEqual(binary);
  await expect(readFile(join(landed.path, "gone.txt"))).rejects.toThrow();
  await expect(readFile(join(landed.path, "secret.env"))).rejects.toThrow();
  expect((await status(landed.path)).split("\n").sort()).toEqual(
    [" D gone.txt", " M README.md", "?? .gitignore", "?? image.bin"].sort(),
  );
  // Here: the checkout is as it was, and nothing of the transfer is left behind.
  expect(await status(path)).toBe(before);
  expect(await git(path, "for-each-ref", "refs/ace")).toBe("");
  expect(await readdir(join(m.source.h.home, "daemon", "transfers", "outgoing"))).toEqual([]);
  expect(await readdir(join(m.target.h.home, "daemon", "transfers", "incoming"))).toEqual([]);
  // The window heard each phase, ending completed.
  const phases = m.here.progress().map((entry) => entry.phase);
  expect(phases[0]).toBe("preparing");
  expect(phases).toContain("sending");
  expect(phases.at(-1)).toBe("completed");
});

it("carries a repository with no remote as a bundle of every branch and tag", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "local");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await writeFile(join(path, "a.txt"), "a\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "one");
  await git(path, "tag", "v1");
  await git(path, "branch", "side");
  const workspaceId = await m.addProject(m.source, path);

  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "bundle" });
  const there = transfer.result?.path ?? "";
  expect(await git(there, "branch", "--format=%(refname:short)")).toBe("main\nside");
  expect(await git(there, "tag")).toBe("v1");
  expect(await git(there, "remote")).toBe("");
});

it("copies a folder that isn't a repository, keeping links inside it and dropping one that escapes", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "notes");
  await mkdir(join(path, "sub"), { recursive: true });
  await writeFile(join(path, "sub", "today.md"), "notes\n");
  await symlink("sub/today.md", join(path, "latest.md"));
  await symlink("../../outside", join(path, "escape"));
  const workspaceId = await m.addProject(m.source, path);

  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "completed", method: "archive" });
  const there = transfer.result?.path ?? "";
  expect(there.startsWith(m.targetRoot)).toBe(true);
  expect(await readFile(join(there, "latest.md"), "utf8")).toBe("notes\n");
  expect((await readdir(there)).sort()).toEqual(["latest.md", "sub"]);
});
