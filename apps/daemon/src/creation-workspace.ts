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
import { resolveAgentWorktreeBase, resolveWorktreeBase } from "./worktree-base-resolution.ts";

type Setup = (
  path: string,
  signal: AbortSignal | undefined,
  progress: CreationProgress | undefined,
  started: () => void,
) => Promise<void>;
type Prepared = NonNullable<CommandContext["preparedWorkspace"]>;
export interface CreationWorkspace {
  workspace: Prepared;
  release(): Promise<void>;
}
/** Physical worktree ownership lasts through acceptance, cancellation and cleanup. */
export class WorkspaceCreations {
  private pending = new Map<ThreadId, Promise<CreationWorkspace>>();
  private closing = false;
  private cleanupFailures = new Map<ThreadId, unknown>();
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
    for (const resource of this.journal.list())
      if (resource.non_executing) this.journal.remember(resource.path);
    for (const path of this.journal.protectedRoots()) this.git.protectWorktree(path);
    this.recovery = this.recover();
    void this.recovery.catch(() => {});
  }
  prepare(
    command: Command,
    progress?: CreationProgress,
    signal?: AbortSignal,
  ): Promise<CreationWorkspace | undefined> {
    return this.prepareQueued(command, progress, signal, (path, lifetime, feedback, started) =>
      this.setupScripts(path, lifetime, feedback, started),
    );
  }
  prepareAgent(command: Command, signal: AbortSignal): Promise<CreationWorkspace | undefined> {
    return this.git.nonExecuting(() => this.prepareQueued(command, undefined, signal));
  }
  private async prepareQueued(
    command: Command,
    progress?: CreationProgress,
    signal?: AbortSignal,
    setup?: Setup,
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
    const task = this.create(id, project, requestedBase(p), progress, signal, setup);
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
    callerSignal?: AbortSignal,
    setup?: Setup,
  ): Promise<CreationWorkspace> {
    const signal =
      progress && callerSignal
        ? AbortSignal.any([progress.controller.signal, callerSignal])
        : (progress?.controller.signal ?? callerSignal);
    signal?.throwIfAborted();
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
    // Only host-authorized preparation may fetch. Agents resolve existing local refs.
    signal?.throwIfAborted();
    if (setup && requested.kind === "branch" && requested.remote) progress?.update("fetching");
    const { head, record } = setup
      ? await resolveWorktreeBase(this.git, project, requested, this.fetchTimeoutMs, {
          ...(signal ? { signal } : {}),
          ...(progress ? { stderr: progress.stderr } : {}),
        })
      : await resolveAgentWorktreeBase(this.git, project, requested);
    const resource: CreationResource = {
      id,
      repo: project,
      path,
      branch,
      base_head: head,
      cleanup_head: null,
      uncertain: 1,
      ran_setup: 0,
      non_executing: setup ? 0 : 1,
    };
    this.journal.acquire(resource);
    if (resource.non_executing) this.git.protectWorktree(path);
    let ranSetup = false;
    try {
      await this.git.createWorktree({
        repo: project,
        path,
        branch,
        baseRef: head,
        ...(signal ? { signal } : {}),
        ...(progress
          ? {
              stderr: progress.stderr,
              onProgress: (value) => progress.update(value.step, value.percent),
            }
          : {}),
      });
      this.journal.head(id, head);
      resource.cleanup_head = head;
      resource.uncertain = 0;
      await setup?.(path, signal, progress, () => {
        ranSetup = true;
        this.journal.setup(id);
        resource.ran_setup = 1;
      });
      signal?.throwIfAborted();
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
      } catch (cleanupFailure) {
        throw new Error("workspace_cleanup_required", { cause: cleanupFailure });
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
  private async setupScripts(
    path: string,
    signal: AbortSignal | undefined,
    progress: CreationProgress | undefined,
    started: () => void,
  ): Promise<void> {
    const scripts = (await listScripts(path)).filter((script) => script.name === "setup");
    for (const script of scripts) {
      signal?.throwIfAborted();
      progress?.update("setup");
      started();
      await this.git.setupWorktree({
        worktree: path,
        command: script.command,
        ...(signal ? { signal } : {}),
        ...(progress ? { stderr: progress.stderr } : {}),
      });
    }
  }
  private cleanup(resource: CreationResource, options: { force?: boolean } = {}): Promise<void> {
    const existing = this.cleanups.get(resource.id);
    if (existing) return existing;
    const cleanup = () =>
      this.cleanupResource(resource, {
        ...options,
        ...(resource.ran_setup ? { force: true } : {}),
      });
    const task = (resource.non_executing ? this.git.nonExecuting(cleanup) : cleanup())
      .then(
        () => {
          this.cleanupFailures.delete(resource.id);
        },
        (error: unknown) => {
          this.cleanupFailures.set(resource.id, error);
          throw error;
        },
      )
      .finally(() => {
        this.cleanups.delete(resource.id);
        this.pending.delete(resource.id);
      });
    this.cleanups.set(resource.id, task);
    return task;
  }
  private async cleanupResource(
    resource: CreationResource,
    options: { force?: boolean },
  ): Promise<void> {
    const retained = this.store.getThread(resource.id)?.details?.worktree === resource.path;
    if (!retained) {
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
    this.journal.release(
      resource.id,
      !retained && resource.non_executing ? resource.path : undefined,
    );
    if (!retained && resource.non_executing) this.git.forgetWorktree(resource.path);
    this.pending.delete(resource.id);
  }
  private async recover(): Promise<void> {
    const resources = this.journal.list();
    if (resources.length > 16) throw new Error("workspace_busy");
    await Promise.allSettled(resources.map((resource) => this.cleanup(resource)));
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
    // Failed preparation drops its live promise, but its durable cleanup ownership remains.
    await this.recover();
    if (this.cleanupFailures.size)
      throw new AggregateError(this.cleanupFailures.values(), "Workspace creation cleanup failed");
  }
}
