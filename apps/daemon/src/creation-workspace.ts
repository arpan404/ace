import { ManagedWorktrees } from "./managed-worktrees.ts";
import { creationResourceId } from "./creation-resource-id.ts";
import type { PreparePrBase } from "./pr-worktree-resolution.ts";
import type { CreationProgress } from "./creation-progress.ts";
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
import { CreationError } from "./creation-failure.ts";
import { runSetupScript, type Setup } from "./creation-setup.ts";
import { settledRetentionMs } from "./creation-drafts.ts";
import {
  abortable,
  checkoutCwd,
  freeBranch,
  insideRoot,
  noCommits,
} from "./creation-preparation.ts";

type Prepared = NonNullable<CommandContext["preparedWorkspace"]>;
export interface CreationWorkspace {
  workspace: Prepared;
  release(): Promise<void>;
  verify?(): Promise<void>;
}
export interface CreationOptions {
  log?: (message: string, error: unknown) => void;
}
const recoveryBatch = 8;
/** Physical worktree ownership lasts through acceptance, cancellation and cleanup. */
export class WorkspaceCreations {
  private pending = new Map<ThreadId, Promise<CreationWorkspace>>();
  private closing = false;
  private lifetime = new AbortController();
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
  private log: (message: string, error: unknown) => void;
  constructor(
    store: Store,
    git: WorkspaceGit,
    directory: string,
    fetchTimeoutMs: number,
    now: () => number,
    preparePr?: PreparePrBase,
    options: CreationOptions = {},
  ) {
    this.now = now;
    this.preparePr = preparePr;
    this.store = store;
    this.git = git;
    this.directory = directory;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.log = options.log ?? (() => {});
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
  }
  prepare(
    command: Command,
    progress?: CreationProgress,
    signal?: AbortSignal,
  ): Promise<CreationWorkspace | undefined> {
    return this.prepareQueued(command, progress, signal, (path, lifetime, feedback, started) =>
      runSetupScript(this.git, path, lifetime, feedback, started),
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
    await abortable(this.recovery, progress?.controller.signal ?? signal);
    const id = ThreadId.parse(p.threadId);
    if (this.store.getThread(id) || this.pending.has(id))
      throw new Error("thread_creation_in_progress");
    if (this.closing || this.pending.size >= 128) throw new Error("workspace_busy");
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
        : this.create(id, project, requested, progress, {
            signal,
            setup: progress?.skipSetup ? undefined : setup,
            host: Boolean(setup),
          });
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
    if (this.closing || this.pending.size >= 128 || this.pending.has(id))
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
      /** Host-authorized preparation may fetch a remote base; agents resolve local refs only. */
      host?: boolean;
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
    const path = join(await realpath(parent), key);
    // Reads before `git worktree add` have no deadline: a large or slow repository takes the
    // time it needs, and Cancel or Use local stops waiting at once.
    const trees = await abortable(this.git.listWorktrees(project, { signal }), signal);
    const kept = this.journal.held(id);
    if (
      kept &&
      trees.some((t) => t.path === kept.resource.path && t.branch === kept.resource.branch)
    )
      return this.resume(kept.resource, project, trees, requested, progress, signal, setup);
    if (kept) this.journal.release(id);
    // A pre-existing checkout has another owner; never adopt or delete it.
    if (trees.some((tree) => tree.path === path))
      throw new Error("workspace_preparation_collision");
    const branch = await freeBranch(this.git, project, `ace/${key.slice(0, 24)}`, signal);
    signal?.throwIfAborted();
    const io = {
      ...(signal ? { signal } : {}),
      ...(progress ? { stderr: progress.stderr } : {}),
    };
    if (
      requested.kind === "pull-request" ||
      (context.host && requested.kind === "branch" && requested.remote)
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
        : await abortable(this.resolveBase(project, requested, io, context.host), signal).catch(
            async (error: unknown) => {
              if (await noCommits(this.git, project, error)) throw new CreationError("no_commits");
              throw error;
            },
          );
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
      non_executing: context.host ? 0 : 1,
    };
    this.journal.acquire(resource);
    if (resource.non_executing) this.git.protectWorktree(path);
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
      // Storage cleanup may have retired this very path for an earlier thread.
      this.store.workspaceReservations.restoreRoot(path);
    } catch (error) {
      if (
        error instanceof GitError &&
        [
          "branch_exists",
          "invalid_ref",
          "not_a_repo",
          "git_missing",
          "git_too_old",
          "branch_checked_out",
          "path_exists",
          "ref_conflict",
          "unborn_head",
        ].includes(error.code)
      ) {
        this.journal.failedBeforeCreation(id);
        resource.uncertain = 0;
      }
      await this.cleanupOrFlag(resource);
      throw error;
    }
    return this.finishCreation(resource, project, trees, requested, progress, signal, {
      setup,
      ...(preparedPr ? { preparedPr } : {}),
      ...(record ? { record } : {}),
    });
  }
  private resolveBase(
    project: string,
    requested: Exclude<RequestedBase, { kind: "pull-request" }>,
    io: { signal?: AbortSignal; stderr?: (chunk: Buffer) => void },
    host: boolean | undefined,
  ) {
    return host
      ? resolveWorktreeBase(this.git, project, requested, this.fetchTimeoutMs, {
          ...io,
          ...(io.signal ? { reads: io.signal } : {}),
        })
      : resolveAgentWorktreeBase(this.git, project, requested, io.signal);
  }
  /** Retry or Continue after a failed setup script: the kept worktree is used as it is. */
  private resume(
    resource: CreationResource,
    project: string,
    trees: readonly { path: string }[],
    requested: RequestedBase,
    progress: CreationProgress | undefined,
    signal: AbortSignal | undefined,
    setup: Setup | undefined,
  ): Promise<CreationWorkspace> {
    this.journal.unhold(resource.id);
    return this.finishCreation(resource, project, trees, requested, progress, signal, { setup });
  }
  private async finishCreation(
    resource: CreationResource,
    project: string,
    trees: readonly { path: string }[],
    requested: RequestedBase,
    progress: CreationProgress | undefined,
    signal: AbortSignal | undefined,
    extra: {
      setup: Setup | undefined;
      preparedPr?: Awaited<ReturnType<PreparePrBase>>;
      record?: Prepared["base"];
    },
  ): Promise<CreationWorkspace> {
    const { preparedPr, record } = extra;
    const { path, branch } = resource;
    try {
      if (extra.setup) await this.runSetup(resource, extra.setup, progress, signal);
      await preparedPr?.verify(path);
      signal?.throwIfAborted();
    } catch (error) {
      if (!this.cleanups.has(resource.id) && !this.journal.held(resource.id))
        await this.cleanupOrFlag(resource);
      throw error;
    }
    // The new branch starts at the commit, not the base's ref, so it gets no upstream: its
    // first push sets a same-named one and can never land on the base branch.
    const workspace: Prepared = {
      id: resource.owner_id ?? resource.id,
      path: await checkoutCwd(trees, project, path),
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
  /**
   * The setup script runs to its own end even when the person cancels: killing it would leave
   * an unconfirmed writer that fences the repository. Cancel stops waiting at once and removes
   * the worktree after the script exits. A failed script keeps the worktree for Retry/Continue.
   */
  private async runSetup(
    resource: CreationResource,
    setup: Setup,
    progress: CreationProgress | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // Cancelled before setup began: nothing runs, so cleanup proceeds at once.
    signal?.throwIfAborted();
    const run = setup(resource.path, this.lifetime.signal, progress, () => {
      this.journal.setup(resource.id);
      resource.ran_setup = 1;
    });
    try {
      await abortable(run, signal);
    } catch (error) {
      if (signal?.aborted && !this.lifetime.signal.aborted) {
        const deferred = run.then(
          () => {},
          () => {},
        );
        this.cleanupAfter(resource, deferred);
        throw error;
      }
      if (this.lifetime.signal.aborted) throw error;
      this.journal.hold(resource.id, this.now());
      throw new CreationError("setup_failed", { cause: error });
    }
  }
  private cleanupAfter(resource: CreationResource, settled: Promise<void>): void {
    const task = settled.then(() => this.cleanupResource(resource, { force: true }));
    const tracked = task
      .then(
        () => {
          this.cleanupFailures.delete(resource.id);
        },
        (error: unknown) => {
          this.cleanupFailures.set(resource.id, error);
          this.log("Worktree cleanup after a cancelled setup failed", error);
        },
      )
      .finally(() => {
        this.cleanups.delete(resource.id);
        this.pending.delete(resource.id);
      });
    this.cleanups.set(resource.id, tracked);
  }
  private async cleanupOrFlag(resource: CreationResource): Promise<void> {
    try {
      await this.cleanup(resource, resource.ran_setup ? { force: true } : {});
    } catch (cleanupFailure) {
      throw new Error("workspace_cleanup_required", { cause: cleanupFailure });
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
    const worktree = this.store.getThread(resource.owner_id ?? resource.id)?.details?.worktree;
    const retained = worktree !== undefined && insideRoot(resource.path, worktree);
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
  /** Startup and lock-clear recovery: every leftover, in batches. Never rejects; failures are logged. */
  private async recover(): Promise<void> {
    try {
      for (const resource of this.journal.heldBefore(this.now() - settledRetentionMs))
        await this.cleanup(resource).catch((error: unknown) =>
          this.log("Kept worktree could not be removed", error),
        );
      let after = "";
      for (;;) {
        const page = this.journal.unsettled(after, recoveryBatch);
        if (!page.length) return;
        const results = await Promise.allSettled(page.map((resource) => this.cleanup(resource)));
        for (const result of results)
          if (result.status === "rejected")
            this.log("Worktree creation cleanup still needs attention", result.reason);
        after = page.at(-1)?.id ?? after;
      }
    } catch (error) {
      this.log("Worktree creation recovery failed", error);
    }
  }
  /** After a stale lock is cleared: retry the cleanups the lock held back. */
  retryCleanup(): Promise<void> {
    const next = this.recovery.then(() => this.recover());
    this.recovery = next;
    return next;
  }
  cleanupComplete(command: Command): boolean {
    const id = creationResourceId(command);
    return !id || !this.journal.owes(id);
  }
  /** Wait out a cleanup still running in the background, then report whether any remains. */
  async cleanupSettled(command: Command): Promise<boolean> {
    const id = creationResourceId(command);
    if (id) await this.cleanups.get(id)?.catch(() => {});
    return this.cleanupComplete(command);
  }
  /** Forget a kept worktree whose start the person dismissed. Never throws. */
  async discard(command: Command): Promise<void> {
    const id = creationResourceId(command);
    const kept = id ? this.journal.held(id) : undefined;
    if (!kept) return;
    this.journal.unhold(kept.resource.id);
    await this.cleanup(kept.resource, { force: true }).catch((error: unknown) =>
      this.log("Kept worktree could not be removed", error),
    );
  }
  async ready(id?: ThreadId): Promise<void> {
    await this.recovery;
    if (id && this.journal.owes(id)) throw new Error("workspace_cleanup_required");
  }
  /**
   * Use local: a kept worktree is removed, and a worktree whose cancelled setup is still
   * running is removed after it, without holding the local thread back.
   */
  async readyForLocal(id: ThreadId): Promise<void> {
    await this.recovery;
    if (this.cleanups.has(id)) return;
    const kept = this.journal.held(id);
    if (kept) {
      this.journal.unhold(id);
      this.cleanupAfter(kept.resource, Promise.resolve());
      return;
    }
    if (this.journal.owes(id)) throw new Error("workspace_cleanup_required");
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.recovery;
    const results = await Promise.allSettled(this.pending.values());
    await Promise.all(
      results.map((result) => (result.status === "fulfilled" ? result.value.release() : undefined)),
    );
    this.lifetime.abort();
    await Promise.allSettled(this.cleanups.values());
    // Failed preparation drops its live promise, but its durable cleanup ownership remains.
    await this.recover();
    if (this.cleanupFailures.size)
      throw new AggregateError(this.cleanupFailures.values(), "Workspace creation cleanup failed");
  }
}
