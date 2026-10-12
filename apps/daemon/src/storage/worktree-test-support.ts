import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, Thread } from "@ace/protocol";
import { GitService, type WorktreeCleanupInput } from "@ace/git";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import { storageFixture } from "./test-support.ts";

export async function git(root: string, ...args: string[]): Promise<string> {
  return (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
}
/** Delay only the uncontrollable Git edge; every inspection and mutation still uses real Git. */
export class CleanupGit extends GitService {
  inspectWhen: (() => boolean) | undefined;
  duringInspection: (() => Promise<void>) | undefined;
  beforeCleanup: (() => Promise<void>) | undefined;
  override async inspectWorktreeCleanup(repo: string, path: string) {
    const state = await super.inspectWorktreeCleanup(repo, path);
    if (this.inspectWhen?.()) {
      const effect = this.duringInspection;
      this.duringInspection = undefined;
      await effect?.();
    }
    return state;
  }
  override async cleanupWorktree(input: WorktreeCleanupInput, beforeRemove?: () => void) {
    const effect = this.beforeCleanup;
    this.beforeCleanup = undefined;
    await effect?.();
    return super.cleanupWorktree(input, beforeRemove);
  }
}
export async function worktreeFixture() {
  const f = await storageFixture();
  const repo = join(f.root, "project");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "file.txt"), "original\n");
  await git(repo, "add", ".");
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@ace.local", "commit", "-m", "Initial");
  await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const workspace = f.store.createWorkspace(repo, "Project", 1);
  const edge = new CleanupGit();
  const runtime = new WorkspaceRuntime(f.store, f.root, f.now, { gitService: edge });
  f.services.workspaceActions = runtime;
  // Go through ace's public preparation path, rather than fabricating cleanup provenance.
  const prepared = await runtime.prepareCreation(Command.parse({ id: "prepare", deviceId: "owner",
    payload: { type: "thread.prepare", threadId: "finished", workspaceId: workspace, provider: "codex",
      title: "Finished", mode: "worktree", base: { ref: "main" } } }));
  if (!prepared) throw new Error("Missing worktree preparation");
  const path = prepared.workspace.path;
  const thread = Thread.parse({ id: "finished", workspaceId: workspace, title: "Finished", provider: "codex",
    status: { state: "done" }, createdAt: 1, updatedAt: 1, archivedAt: 1,
    details: { mode: "worktree", worktree: path, branch: prepared.workspace.branch } });
  f.store.appendEvents(thread.id, [{ type: "thread.created", thread }], 1);
  await prepared.release();
  f.advance(Date.now());
  return { ...f, repo, path, thread, edge, runtime,
    async close() { await f.storage.close(); await runtime.close(); await f.close(); } };
}
