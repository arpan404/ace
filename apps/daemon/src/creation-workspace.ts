import type { CreationProgress } from "./creation-progress.ts";
import { listScripts } from "./workspace-scripts.ts";
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
import { requestedBase, requestedBaseKey, type RequestedBase } from "./worktree-base.ts";
import { resolveWorktreeBase } from "./worktree-base-resolution.ts";

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
  private fetchTimeoutMs: number;
  constructor(store: Store, git: WorkspaceGit, directory: string, fetchTimeoutMs: number) {
    this.store = store;
    this.git = git;
    this.directory = directory;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.journal = new CreationWorkspaceJournal(store);
    this.recovery = this.recover();
    void this.recovery.catch(() => {});
  }
  async prepare(
    command: Command,
    progress?: CreationProgress,
  ): Promise<CreationWorkspace | undefined> {
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
    const task = this.create(id, project, requestedBase(p), progress);
    this.pending.set(id, task);
    try {
      return await task;
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }
  private async create(
    id: ThreadId,
    root: string,
    requested: RequestedBase,
    progress?: CreationProgress,
  ): Promise<CreationWorkspace> {
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
    // A remote base is fetched here, before any physical work; only its remote-tracking ref moves.
    progress?.controller.signal.throwIfAborted();
    if (requested.kind === "branch" && requested.remote) progress?.update("fetching");
    const { head, record } = await resolveWorktreeBase(
      this.git,
      project,
      requested,
      this.fetchTimeoutMs,
      progress ? { signal: progress.controller.signal, stderr: progress.stderr } : {},
    );
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
    let ranSetup = false;
    try {
      await this.git.createWorktree({
        repo: project,
        path,
        branch,
        baseRef: head,
        ...(progress
          ? {
              signal: progress.controller.signal,
              stderr: progress.stderr,
              onProgress: (value) => progress.update(value.step, value.percent),
            }
          : {}),
      });
      this.journal.head(id, head);
      resource.cleanup_head = head;
      resource.uncertain = 0;
      const scripts = (await listScripts(path)).filter((script) => script.name === "setup");
      for (const script of scripts) {
        progress?.controller.signal.throwIfAborted();
        progress?.update("setup");
        ranSetup = true;
        await this.git.setupWorktree({
          worktree: path,
          command: script.command,
          ...(progress ? { stderr: progress.stderr } : {}),
        });
      }
      progress?.controller.signal.throwIfAborted();
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
      try {
        await this.cleanup(resource, ranSetup ? { force: true } : {});
      } catch {
        throw new Error("workspace_cleanup_required");
      }
      throw error;
    }
    // The new branch starts at the commit, not the base's ref, so it gets no upstream: its
    // first push sets a same-named one and can never land on the base branch.
    const workspace: Prepared = {
      id,
      path,
      branch,
      project,
      requestedBase: requestedBaseKey(requested),
      ...(record ? { base: record } : {}),
    };
    const lease: CreationWorkspace = { workspace, release: () => this.cleanup(resource) };
    if (this.closing) {
      await lease.release();
      throw new Error("workspace_closed");
    }
    progress?.update("done");
    return lease;
  }
  private cleanup(resource: CreationResource, options: { force?: boolean } = {}): Promise<void> {
    const existing = this.cleanups.get(resource.id);
    if (existing) return existing;
    const task = this.cleanupResource(resource, options).finally(() =>
      this.cleanups.delete(resource.id),
    );
    this.cleanups.set(resource.id, task);
    return task;
  }
  private async cleanupResource(
    resource: CreationResource,
    options: { force?: boolean },
  ): Promise<void> {
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
        options,
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
  async ready(id?: ThreadId): Promise<void> {
    await this.recovery;
    if (id && this.journal.list().some((resource) => resource.id === id))
      throw new Error("workspace_cleanup_required");
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
