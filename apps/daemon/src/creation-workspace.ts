import { ManagedWorktrees } from "./managed-worktrees.ts";
import { creationResourceId } from "./creation-resource-id.ts";
import type { PreparePrBase } from "./pr-worktree-resolution.ts";
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
  verify?(): Promise<void>;
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
  private now: () => number;
  private preparePr: PreparePrBase | undefined;
  constructor(
    store: Store,
    git: WorkspaceGit,
    directory: string,
    fetchTimeoutMs: number,
    now: () => number,
    preparePr?: PreparePrBase,
  ) {
    this.now = now;
    this.preparePr = preparePr;
    this.store = store;
    this.git = git;
    this.directory = directory;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.journal = new CreationWorkspaceJournal(store);
    // Backfill pre-policy leases and admitted PR bindings. Retained checkouts keep their
    // protection across workspace switches and restarts, even after their lease is released.
    for (const resource of this.journal.list())
      if (resource.non_executing) this.journal.remember(resource.path);
    for (const thread of store.listThreads())
      if (thread.details?.pullRequestWorkspace && thread.details.worktree)
        this.journal.remember(thread.details.worktree);
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
    const requested = requestedBase(p);
    const task =
      requested.kind === "pull-request"
        ? this.git.nonExecuting(() =>
            this.create(id, project, requested, progress, {
              signal,
              preparePr: setup ? this.preparePr : undefined,
            }),
          )
        : this.create(id, project, requested, progress, { signal, setup });
    this.pending.set(id, task);
    try {
      return await task;
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }
  async prepareExisting(command: Command, progress?: CreationProgress): Promise<CreationWorkspace> {
    const p = command.payload;
    if (p.type !== "forge.pr.worktree") throw new Error("invalid_command");
    const thread = this.store.getThread(p.threadId);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    const project = this.store.getWorkspacePath(thread.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    const requested: RequestedBase = { kind: "pull-request", selection: p.pullRequest };
    const id = creationResourceId(command);
    if (!id) throw new Error("invalid_command");
    await this.ready(id);
    if (this.closing || this.pending.size >= 16 || this.pending.has(id))
      throw new Error("workspace_busy");
    const task = this.git.nonExecuting(() =>
      this.create(id, project, requested, progress, {
        ownerId: p.threadId,
        preparePr: this.preparePr,
      }),
    );
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
    context: {
      signal?: AbortSignal | undefined;
      setup?: Setup | undefined;
      preparePr?: PreparePrBase | undefined;
      ownerId?: ThreadId;
    } = {},
  ): Promise<CreationWorkspace> {
    const { signal: callerSignal, setup } = context;
    const ownerId = context.ownerId ?? id;
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
    const io = {
      ...(signal ? { signal } : {}),
      ...(progress ? { stderr: progress.stderr } : {}),
    };
    if (
      requested.kind === "pull-request" ||
      (setup && requested.kind === "branch" && requested.remote)
    )
      progress?.update("fetching");
    const preparedPr =
      requested.kind === "pull-request"
        ? await context.preparePr?.(project, requested.selection, io)
        : undefined;
    if (requested.kind === "pull-request" && !preparedPr)
      throw new Error("forge_recovery_unavailable");
    const { head, record } =
      requested.kind === "pull-request"
        ? { head: preparedPr?.head ?? "", record: undefined }
        : setup
          ? await resolveWorktreeBase(this.git, project, requested, this.fetchTimeoutMs, io)
          : await resolveAgentWorktreeBase(this.git, project, requested);
    const resource: CreationResource = {
      id,
      owner_id: ownerId,
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
      await new ManagedWorktrees(this.store, this.directory).created(
        this.git,
        project,
        path,
        ownerId,
        this.now(),
      );
      this.journal.head(id, head);
      resource.cleanup_head = head;
      resource.uncertain = 0;
      await setup?.(path, signal, progress, () => {
        ranSetup = true;
        this.journal.setup(id);
        resource.ran_setup = 1;
      });
      await preparedPr?.verify(path);
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
      id: ownerId,
      path,
      branch,
      project,
      requestedBase: requestedBaseKey(requested),
      ...(record ? { base: record } : {}),
      ...(preparedPr
        ? { pullRequestWorkspace: preparedPr.pullRequestWorkspace, prStatus: preparedPr.prStatus }
        : {}),
    };
    const lease: CreationWorkspace = {
      workspace,
      release: async () => {
        try {
          await this.cleanup(resource);
        } catch (error) {
          throw new Error("workspace_cleanup_required", { cause: error });
        }
      },
      ...(preparedPr ? { verify: () => this.git.nonExecuting(() => preparedPr.verify(path)) } : {}),
    };
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
    const retained =
      this.store.getThread(resource.owner_id ?? resource.id)?.details?.worktree === resource.path;
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
  cleanupComplete(command: Command): boolean {
    const id = creationResourceId(command);
    return !id || !this.journal.list().some((resource) => resource.id === id);
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
