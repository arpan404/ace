import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { bundleDaemon } from "@ace/release";

test("the packaged storage worker inspects and removes a checkout without source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-storage-bundle-"));
  const execute = promisify(execFile);
  const repo = join(root, "project");
  const path = join(root, "checkout");
  const source = resolve(import.meta.dirname, "../../..", "apps/daemon/src/storage/worktree-io.ts");
  const entry = join(root, "entry.ts");
  const git = (...args: string[]) => execute("git", ["-C", repo, ...args]);
  try {
    await mkdir(repo);
    await git("init", "-b", "main");
    await writeFile(join(repo, "file.txt"), "kept in main\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "Initial",
    );
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("worktree", "add", "-b", "completed", path, "main");
    await writeFile(
      entry,
      `
import { WorktreeIO } from ${JSON.stringify(source)};
const io = new WorktreeIO();
try {
  const state = await io.inspectWorktreeCleanup(${JSON.stringify(repo)}, ${JSON.stringify(path)});
  if (state.dirty || !state.mergedIntoMain) throw new Error('Unexpected checkout state');
  await io.cleanupWorktree({repo:${JSON.stringify(repo)},path:${JSON.stringify(path)},fingerprint:state.fingerprint,force:false,removeBranch:false});
  console.log('storage worker removed checkout');
} finally { await io.close(); }
`,
    );
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, "", undefined, entry);
    await rm(entry);
    const result = await execute(process.execPath, [join(root, "ace.mjs")], {
      cwd: root,
      timeout: 30000,
      maxBuffer: 65536,
    });
    expect(result.stdout.trim()).toBe("storage worker removed checkout");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await access(join(repo, "file.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
