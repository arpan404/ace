import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);
const git = (root: string, ...args: string[]) => execute("git", ["-C", root, ...args]);

async function branchList(prepare: (root: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "ace-branch-list-"));
  const root = join(home, "project");
  await execute("git", ["init", "-b", "main", root]);
  await git(root, "config", "user.name", "ace test");
  await git(root, "config", "user.email", "test@ace.local");
  await prepare(root);
  const store = new Store(join(home, "events.sqlite"));
  const runtime = new WorkspaceRuntime(store, join(home, "data"), () => 1000);
  try {
    const workspaceId = store.createWorkspace(root, "Project");
    const reply = await runtime.read({
      type: "workspace.request",
      requestId: "branches",
      operation: { op: "branches.list", workspaceId },
    });
    return reply.result;
  } finally {
    await runtime.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
}

test("a repository with no commit yet reports an unborn HEAD", async () => {
  expect(await branchList(async () => {})).toMatchObject({
    kind: "branches",
    branches: [],
    unbornHead: true,
  });
});

test("a detached HEAD with no branches has commits, so its HEAD is not unborn", async () => {
  const result = await branchList(async (root) => {
    await writeFile(join(root, "file.txt"), "commit\n");
    await git(root, "add", "file.txt");
    await git(root, "commit", "-m", "Initial");
    await git(root, "checkout", "--detach");
    await git(root, "branch", "-D", "main");
  });
  expect(result).toMatchObject({ kind: "branches", branches: [], unbornHead: false });
});
