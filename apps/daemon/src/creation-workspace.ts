import { GitError } from "@ace/git";
import { cleanupOwnedWorktree } from "./owned-worktree.ts";
import { CreationWorkspaceJournal, type CreationResource } from "./creation-workspace-journal.ts";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ThreadId, type Command } from "@ace/protocol";
import type { WorkspaceGit } from "./workspace-roots.ts";
import type { Store } from "./store.ts";
import type { CommandContext } from "./commands.ts";

type Prepared = NonNullable<CommandContext["preparedWorkspace"]>;
export interface CreationWorkspace {
  workspace: Prepared;
  release(): Promise<void>;
}
/** Physical worktree ownership lasts through acceptance, cancellation and cleanup. */
export class WorkspaceCreations {
  private pending = new Map<ThreadId, Promise<CreationWorkspace>>();
  private closing = false;
  private cleanups = new Map<ThreadId, Promise<void>>();
  private journal: CreationWorkspaceJournal;
  private recovery: Promise<void>;
  private store: Store;
  private git: WorkspaceGit;
  private directory: string;
  constructor(store: Store, git: WorkspaceGit, directory: string) {
    this.store = store;
    this.git = git;
    this.directory = directory;
    this.journal = new CreationWorkspaceJournal(store);
    this.recovery = this.recover();
    void this.recovery.catch(() => {});
  }
  async prepare(command: Command): Promise<CreationWorkspace | undefined> {
    const p = command.payload;
    if ((p.type !== "thread.create" && p.type !== "thread.prepare") || p.mode !== "worktree")
      return;
    await this.recovery;
    const id = ThreadId.parse(p.threadId);
    if (this.store.getThread(id) || this.pending.has(id))
      throw new Error("thread_creation_in_progress");
    if (this.closing || this.pending.size >= 16) throw new Error("workspace_busy");
    const project = this.store.getWorkspacePath(p.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    const task = this.create(id, project, p.baseBranch ?? "HEAD");
    this.pending.set(id, task);
    try {
      return await task;
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }
  private async create(id: ThreadId, root: string, baseBranch: string): Promise<CreationWorkspace> {
    const project = await realpath(root);
    const key = createHash("sha256").update(id).digest("hex");
    const parent = join(this.directory, "worktrees");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const path = join(await realpath(parent), key),
      branch = `ace/${key.slice(0, 24)}`;
    // A pre-existing checkout has another owner; never adopt or delete it.
    if ((await this.git.listWorktrees(project)).some((tree) => tree.path === path))
      throw new Error("workspace_preparation_collision");
    try {
      await this.git.resolveCommit({ worktree: project, ref: `refs/heads/${branch}` });
      throw new Error("workspace_preparation_collision");
    } catch (error) {
      if (!(error instanceof GitError && error.code === "invalid_ref")) throw error;
    }
    const head = await this.git.resolveCommit({ worktree: project, ref: baseBranch });
    const resource: CreationResource = {
      id,
      repo: project,
      path,
      branch,
      base_head: head,
      cleanup_head: null,
      uncertain: 1,
    };
    this.journal.acquire(resource);
    try {
      await this.git.createWorktree({ repo: project, path, branch, baseRef: head });
      this.journal.head(id, head);
      resource.cleanup_head = head;
      resource.uncertain = 0;
    } catch (error) {
      if (
        error instanceof GitError &&
        ["branch_exists", "invalid_ref", "not_a_repo", "git_missing", "git_too_old"].includes(
          error.code,
        )
      ) {
        this.journal.failedBeforeCreation(id);
        resource.uncertain = 0;
      }
      await this.cleanup(resource);
      throw error;
    }
    const workspace = { id, path, branch, project, baseBranch };
    const lease: CreationWorkspace = { workspace, release: () => this.cleanup(resource) };
    if (this.closing) {
      await lease.release();
      throw new Error("workspace_closed");
    }
    return lease;
  }
  private cleanup(resource: CreationResource): Promise<void> {
    const existing = this.cleanups.get(resource.id);
    if (existing) return existing;
    const task = this.cleanupResource(resource).finally(() => this.cleanups.delete(resource.id));
    this.cleanups.set(resource.id, task);
    return task;
  }
  private async cleanupResource(resource: CreationResource): Promise<void> {
    if (this.store.getThread(resource.id)?.details?.worktree !== resource.path) {
      await cleanupOwnedWorktree(
        this.git,
        {
          repo: resource.repo,
          path: resource.path,
          branch: resource.branch,
          baseHead: resource.base_head,
          cleanupHead: resource.cleanup_head,
          uncertain: resource.uncertain === 1,
        },
        (head) => {
          this.journal.head(resource.id, head);
          resource.cleanup_head = head;
        },
      );
    }
    this.journal.release(resource.id);
    this.pending.delete(resource.id);
  }
  private async recover(): Promise<void> {
    const resources = this.journal.list();
    if (resources.length > 16) throw new Error("workspace_busy");
    await Promise.all(resources.map((resource) => this.cleanup(resource)));
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.recovery.catch(() => {});
    const results = await Promise.allSettled(this.pending.values());
    await Promise.all(
      results.map((result) => (result.status === "fulfilled" ? result.value.release() : undefined)),
    );
  }
}
