import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitService } from "@ace/git";
import { expect, test } from "vitest";
import { projectFixture } from "./projects-test-support.ts";

test("a quarantined repository can be registered and inspected without releasing its mutation fence", async () => {
  const f = await projectFixture();
  const git = new GitService();
  try {
    const path = join(f.root, "project");
    await mkdir(path);
    await f.git(path, ["init", "--initial-branch=main"]);
    const journal = join(path, ".git", "ace-mutation-leases");
    await mkdir(journal);
    const id = "03f51536-8c5e-4f64-bc5f-8b14d86150b3";
    const file = join(journal, id);
    const lease = JSON.stringify({ version: 1, id, root: path, roots: [path] });
    await writeFile(file, lease);
    const added = await f.command({ type: "workspace.add", path });
    expect(added).toMatchObject({
      ok: true,
      workspace: { path, name: "project" },
      inspection: { git: null, gitUnavailable: "git_quarantined" },
    });
    expect((await f.read({ op: "workspace.inspect", path })).result).toMatchObject({
      kind: "inspection",
      git: null,
      gitUnavailable: "git_quarantined",
    });
    await expect(git.assertMutationAvailable(path)).rejects.toMatchObject({
      code: "git_quarantined",
    });
    expect(await readFile(file, "utf8")).toBe(lease);
  } finally {
    await git.close();
    await f.close();
  }
});
