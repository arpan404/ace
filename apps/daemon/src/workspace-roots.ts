import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { GitError, type GitService } from "@ace/git";
import { repositoryFromRemote } from "@ace/forge";
import { ThreadId, type ThreadDetails, type Command } from "@ace/protocol";
import type { Store } from "./store.ts";
export type WorkspaceGit = Pick<GitService, keyof GitService>;
/** Thin filesystem/Git shell around the provider session's durable root binding. */
export class WorkspaceRoots {
  private preparations = new Map<ThreadId, Promise<string>>();
  private closing = false;
  private store: Store;
  private git: WorkspaceGit;
  private directory: string;
  private now: () => number;
  private machine: { host: string; name: string };
  constructor(
    store: Store,
    git: WorkspaceGit,
    directory: string,
    now: () => number,
    machine: { host: string; name: string },
  ) {
    this.store = store;
    this.git = git;
    this.directory = directory;
    this.now = now;
    this.machine = machine;
  }
  root(id: ThreadId): string {
    const binding = this.store.executionWorkspace(id);
    if (!binding.ready) throw new Error("workspace_preparing");
    return binding.path;
  }
  prepare(id: ThreadId): Promise<string> {
    if (this.closing) return Promise.reject(new Error("workspace_closed"));
    const binding = this.store.executionWorkspace(id);
    if (binding.ready) return Promise.resolve(binding.path);
    const existing = this.preparations.get(id);
    if (existing) return existing;
    if (this.preparations.size >= 16) return Promise.reject(new Error("workspace_busy"));
    const preparation = this.preparePending(id, binding.path).finally(() =>
      this.preparations.delete(id),
    );
    this.preparations.set(id, preparation);
    return preparation;
  }
  private async preparePending(id: ThreadId, expectedRoot: string): Promise<string> {
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    const project = this.store.getWorkspacePath(thread.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    const { path, branch } = await this.createWorktree(id, project, thread.details?.baseBranch);
    if (this.closing) throw new Error("workspace_closed");
    this.store.atomic(() => {
      if (!this.store.completeWorkspacePreparation(id, expectedRoot, path))
        throw new Error("workspace_root_changed");
      const current = this.store.getThread(id);
      if (!current) throw new Error("thread_not_found");
      this.store.appendEvents(
        id,
        [
          {
            type: "thread.client.updated",
            changes: {
              details: { ...current.details, worktree: path, branch, machine: this.machine },
            },
          },
        ],
        this.now(),
      );
    });
    return path;
  }
  /** Physical preparation precedes command acceptance; no thread or input has been committed yet. */
  async prepareCreation(
    command: Command,
  ): Promise<{ id: ThreadId; path: string; branch: string } | undefined> {
    const p = command.payload;
    if ((p.type !== "thread.create" && p.type !== "thread.prepare") || p.mode !== "worktree")
      return;
    const id = ThreadId.parse(
      p.threadId ?? createHash("sha256").update(`${command.deviceId}:${command.id}`).digest("hex"),
    );
    if (this.store.getThread(id)) return;
    const project = this.store.getWorkspacePath(p.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    const existing = this.preparations.get(id);
    if (existing) {
      const path = await existing;
      return {
        id,
        path,
        branch: `ace/${createHash("sha256").update(id).digest("hex").slice(0, 24)}`,
      };
    }
    if (this.closing || this.preparations.size >= 16) throw new Error("workspace_busy");
    const preparation = this.createWorktree(id, project, p.baseBranch)
      .then(({ path }) => path)
      .finally(() => this.preparations.delete(id));
    this.preparations.set(id, preparation);
    const path = await preparation;
    return {
      id,
      path,
      branch: `ace/${createHash("sha256").update(id).digest("hex").slice(0, 24)}`,
    };
  }
  private async createWorktree(
    id: ThreadId,
    project: string,
    baseBranch?: string,
  ): Promise<{ path: string; branch: string }> {
    const key = createHash("sha256").update(id).digest("hex");
    await mkdir(join(this.directory, "worktrees"), { recursive: true, mode: 0o700 });
    const path = join(await realpath(join(this.directory, "worktrees")), key);
    const branch = `ace/${key.slice(0, 24)}`;
    const existing = (await this.git.listWorktrees(project)).find(
      (tree) => tree.path === path && tree.branch === branch,
    );
    if (!existing) {
      await this.git.createWorktree({
        repo: project,
        path,
        baseRef: baseBranch ?? "HEAD",
        branch,
      });
    }
    if (this.closing) throw new Error("workspace_closed");
    return { path, branch };
  }
  async changeRoots(id: ThreadId, mode: "local" | "worktree"): Promise<string[]> {
    const thread = this.store.getThread(id);
    if (!thread) throw new Error("thread_not_found");
    const project = this.store.getWorkspacePath(thread.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    const row = this.store.atomic((db) =>
      db.prepare("SELECT cwd FROM engine_sessions WHERE thread_id=?").get(id),
    );
    if (typeof row?.cwd !== "string") throw new Error("workspace_unavailable");
    const source = await realpath(row.cwd);
    let destination = await realpath(project);
    if (mode === "worktree") {
      await mkdir(join(this.directory, "worktrees"), { recursive: true, mode: 0o700 });
      destination = join(
        await realpath(join(this.directory, "worktrees")),
        createHash("sha256").update(id).digest("hex"),
      );
    }
    return [...new Set([source, destination])];
  }
  async change(
    id: ThreadId,
    selection: {
      mode: "local" | "worktree";
      branch?: string | undefined;
      allowUncommitted: boolean;
    },
  ): Promise<ThreadDetails> {
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    const project = this.store.getWorkspacePath(thread.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    const previous = this.store.atomic((db) =>
      db.prepare("SELECT cwd FROM engine_sessions WHERE thread_id=?").get(id),
    );
    if (typeof previous?.cwd !== "string") throw new Error("workspace_unavailable");
    const status = await this.git.status(previous.cwd);
    if (status.conflicted.length)
      throw new GitError("conflicts", "Resolve conflicts before switching");
    if (
      !selection.allowUncommitted &&
      (status.staged.length || status.unstaged.length || status.untracked.length)
    )
      throw new GitError("dirty_worktree", "Commit or explicitly allow uncommitted changes");
    let path = await realpath(project);
    if (selection.mode === "worktree") {
      const key = createHash("sha256").update(id).digest("hex");
      await mkdir(join(this.directory, "worktrees"), { recursive: true, mode: 0o700 });
      path = join(await realpath(join(this.directory, "worktrees")), key);
      const existing = (await this.git.listWorktrees(project)).find((tree) => tree.path === path);
      if (!existing)
        await this.git.createWorktree({
          repo: project,
          path,
          branch: selection.branch ?? `ace/${key.slice(0, 24)}`,
          baseRef: selection.branch ?? thread.details?.baseBranch ?? "HEAD",
          reuseBranch: true,
        });
      else if (selection.branch)
        await this.git.switchBranch({
          worktree: path,
          branch: selection.branch,
          allowUncommitted: selection.allowUncommitted,
        });
    } else if (selection.branch)
      await this.git.switchBranch({
        worktree: path,
        branch: selection.branch,
        allowUncommitted: selection.allowUncommitted,
      });
    const info = await this.git.repositoryInfo(path);
    return {
      ...thread.details,
      mode: selection.mode,
      worktree: path,
      branch: info.branch,
      head: info.head,
      ahead: info.ahead,
      behind: info.behind,
      machine: this.machine,
      ...(selection.branch ? { baseBranch: selection.branch } : {}),
    };
  }
  async details(id: ThreadId): Promise<ThreadDetails> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const root = this.root(id);
      const info = await this.git.repositoryInfo(root);
      const diff = info.head
        ? await this.git.diff({
            worktree: root,
            from: { kind: "commit", ref: info.head },
            to: { kind: "working-tree" },
            maxPatchBytes: 1,
          })
        : undefined;
      const thread = this.store.getThread(id);
      if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
      const project = this.store.getWorkspace(thread.workspaceId);
      if (!project) throw new Error("workspace_not_found");
      const projectPath = await realpath(project.path);
      const repository = originRepository(info.remotes);
      // Never publish a read from an old binding. There is no await between comparison and write.
      if (this.root(id) !== root) continue;
      const current = this.store.getThread(id);
      if (!current) throw new Error("thread_not_found");
      const details: ThreadDetails = {
        ...current.details,
        workspace: { id: current.workspaceId, name: project.name, path: project.path },
        mode: current.details?.mode ?? (info.root === projectPath ? "local" : "worktree"),
        worktree: root,
        branch: info.branch,
        head: info.head,
        ahead: info.ahead,
        behind: info.behind,
        ...(repository ? { repository } : {}),
        machine: this.machine,
        ...(diff
          ? {
              diff: {
                files: diff.entries.length,
                additions: diff.entries.reduce((n, file) => n + file.additions, 0),
                deletions: diff.entries.reduce((n, file) => n + file.deletions, 0),
              },
            }
          : {}),
      };
      if (JSON.stringify(current.details) !== JSON.stringify(details))
        this.store.appendEvents(
          id,
          [{ type: "thread.client.updated", changes: { details } }],
          this.now(),
        );
      return details;
    }
    throw new Error("workspace_root_changed");
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.preparations.values());
  }
}

/** The forge repository of the origin remote (else the first), or undefined when unsupported. */
function originRepository(
  remotes: readonly { name: string; fetchUrls: readonly string[] }[],
): ThreadDetails["repository"] {
  const remote = (remotes.find((entry) => entry.name === "origin") ?? remotes[0])?.fetchUrls[0];
  if (!remote) return undefined;
  try {
    return repositoryFromRemote(remote);
  } catch {
    return undefined;
  }
}
