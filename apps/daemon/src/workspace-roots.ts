import type { PreparePrBase } from "./pr-worktree-resolution.ts";
import type { CreationProgress } from "./creation-progress.ts";
import { WorkspaceCreations, type CreationOptions } from "./creation-workspace.ts";
import { realpath } from "node:fs/promises";
import type { GitService } from "@ace/git";
import { checkoutCwd } from "./creation-preparation.ts";
import { LateSetup } from "./late-setup.ts";
import {
  ensureThreadWorktree,
  exists,
  moveCheckout,
  moveReservation,
  type MoveContext,
} from "./workspace-move.ts";
import { workspaceRepository } from "./workspace-repository.ts";
import type { SourceControl } from "./source-control.ts";
import { ThreadId, type ThreadDetails, type Command } from "@ace/protocol";
import type { Store } from "./store.ts";
import { recordedBaseRef } from "./worktree-base.ts";
import { defaultBaseFetchTimeoutMs } from "./worktree-base-resolution.ts";
export type WorkspaceGit = Pick<GitService, keyof GitService>;
/** Thin filesystem/Git shell around the provider session's durable root binding. */
export class WorkspaceRoots {
  private preparations = new Map<ThreadId, Promise<string>>();
  private closing = false;
  private creations: WorkspaceCreations;
  private setup: LateSetup;
  private store: Store;
  private git: WorkspaceGit;
  private directory: string;
  private now: () => number;
  private sourceControl: SourceControl | undefined;
  private machine: { host: string; name: string };
  constructor(
    store: Store,
    git: WorkspaceGit,
    directory: string,
    now: () => number,
    machine: { host: string; name: string },
    options: {
      baseFetchTimeoutMs?: number;
      preparePr?: PreparePrBase;
      sourceControl?: SourceControl;
      creation?: CreationOptions;
    } = {},
  ) {
    this.creations = new WorkspaceCreations(
      store,
      git,
      directory,
      options.baseFetchTimeoutMs ?? defaultBaseFetchTimeoutMs,
      now,
      options.preparePr,
      options.creation,
    );
    this.store = store;
    this.git = git;
    this.setup = new LateSetup(store, git, now);
    this.directory = directory;
    this.now = now;
    this.machine = machine;
    this.sourceControl = options.sourceControl;
  }
  creationReady(): Promise<void> {
    return this.creations.ready();
  }
  creationCleanupComplete(command: Command): boolean {
    return this.creations.cleanupComplete(command);
  }
  creationCleanupSettled(command: Command): Promise<boolean> {
    return this.creations.cleanupSettled(command);
  }
  discardCreation(command: Command): Promise<void> {
    return this.creations.discard(command);
  }
  retryCreationCleanup(): Promise<void> {
    return this.creations.retryCleanup();
  }
  private get move(): MoveContext {
    return {
      store: this.store,
      git: this.git,
      directory: this.directory,
      now: this.now,
      machine: this.machine,
    };
  }
  prepareExistingPr(command: Command, progress?: CreationProgress) {
    return this.creations.prepareExisting(command, progress);
  }
  root(id: ThreadId): string {
    const binding = this.store.executionWorkspace(id);
    if (!binding.ready) throw new Error("workspace_preparing");
    return binding.path;
  }
  /** Retry or Continue after a late worktree's failed setup script. */
  chooseSetup(id: ThreadId, choice: "retry" | "continue"): "settled" | undefined {
    return this.setup.choose(id, choice);
  }
  prepare(id: ThreadId, policy: { runCommands: boolean }): Promise<string> {
    if (this.closing) return Promise.reject(new Error("workspace_closed"));
    const binding = this.store.executionWorkspace(id);
    if (binding.ready) return Promise.resolve(binding.path);
    const existing = this.preparations.get(id);
    if (existing) return existing;
    if (this.preparations.size >= 16) return Promise.reject(new Error("workspace_busy"));
    const preparation = this.preparePending(id, binding.path, policy).finally(() =>
      this.preparations.delete(id),
    );
    this.preparations.set(id, preparation);
    return preparation;
  }
  private async preparePending(
    id: ThreadId,
    expectedRoot: string,
    policy: { runCommands: boolean },
  ): Promise<string> {
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    const project = this.store.getWorkspacePath(thread.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    // Late preparation never fetches: it starts from a recorded base's exact commit, else the
    // recorded `baseBranch` as Git resolves it (a remote one from its last fetched copy).
    const made = await ensureThreadWorktree(this.move, id, project, {
      baseRef: recordedBaseRef(thread.details),
    });
    const { branch } = made;
    // Before the binding is ready: a failed setup leaves it pending, so Retry runs it again.
    await this.setup.run(id, made.path, made.created, policy);
    const path = await checkoutCwd(
      await this.git.listWorktrees(project),
      await realpath(project),
      made.path,
    );
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
  prepareAgentCreation(command: Command, signal: AbortSignal) {
    return this.creations.prepareAgent(command, signal);
  }
  prepareCreation(command: Command, progress?: CreationProgress, signal?: AbortSignal) {
    return this.creations.prepare(command, progress, signal);
  }
  async localCreation(command: Command): Promise<void> {
    const p = command.payload;
    if (p.type !== "thread.create" && p.type !== "thread.prepare")
      throw new Error("invalid_command");
    const path = this.store.getWorkspacePath(p.workspaceId);
    if (!path) throw new Error("workspace_not_found");
    if (p.threadId) await this.creations.readyForLocal(ThreadId.parse(p.threadId));
    else await this.creations.ready();
    await this.git.assertMutationAvailable(path);
  }
  changeRoots(
    id: ThreadId,
    selection: { mode: "local" | "worktree"; branch?: string | undefined },
  ) {
    const thread = this.store.getThread(id);
    if (!thread) throw new Error("thread_not_found");
    const project = this.store.getWorkspacePath(thread.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    return moveReservation(this.move, id, project, selection);
  }
  change(
    id: ThreadId,
    selection: {
      mode: "local" | "worktree";
      branch?: string | undefined;
      allowUncommitted: boolean;
    },
  ): Promise<ThreadDetails> {
    return moveCheckout(this.move, id, selection);
  }
  /** A checkout that was deleted, or removed by storage cleanup, is reported, not thrown. */
  private async missing(id: ThreadId): Promise<ThreadDetails | undefined> {
    const row = this.store.atomic((db) =>
      db.prepare("SELECT cwd FROM engine_sessions WHERE thread_id=? AND workspace_ready=1").get(id),
    );
    if (typeof row?.cwd !== "string") return undefined;
    if (!this.store.workspaceReservations.removedRoot(row.cwd) && (await exists(row.cwd)))
      return undefined;
    const current = this.store.getThread(id);
    if (!current) throw new Error("thread_not_found");
    const details: ThreadDetails = { ...current.details, worktreeMissing: true };
    if (!current.details?.worktreeMissing)
      this.store.appendEvents(
        id,
        [{ type: "thread.client.updated", changes: { details } }],
        this.now(),
      );
    return details;
  }
  async details(id: ThreadId): Promise<ThreadDetails> {
    const missing = await this.missing(id);
    if (missing) return missing;
    for (let attempt = 0; attempt < 2; attempt++) {
      const check = await this.sourceControl?.guard();
      const root = this.root(id);
      const info = await this.git.repositoryInfo(root);
      const changed = await this.git.changeSummary(root);
      const thread = this.store.getThread(id);
      if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
      const project = this.store.getWorkspace(thread.workspaceId);
      if (!project) throw new Error("workspace_not_found");
      const projectPath = await realpath(project.path);
      const repository = workspaceRepository(
        info.remotes,
        await this.sourceControl?.preferences(),
        await this.sourceControl?.hostAliases(
          info.remotes.flatMap((remote) => remote.fetchUrls),
          new AbortController().signal,
        ),
      );
      check?.();
      // Never publish a read from an old binding. There is no await between comparison and write.
      if (this.root(id) !== root) continue;
      const current = this.store.getThread(id);
      if (!current) throw new Error("thread_not_found");
      const details: ThreadDetails = {
        ...current.details,
        workspace: { ...project, id: current.workspaceId },
        mode: current.details?.mode ?? (info.root === projectPath ? "local" : "worktree"),
        worktree: root,
        branch: info.branch,
        head: info.head,
        ahead: info.ahead,
        behind: info.behind,
        ...(repository ? { repository } : {}),
        machine: this.machine,
        diff: changed,
      };
      delete details.worktreeMissing;
      if (!repository) delete details.repository;
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
    await this.creations.close();
    await Promise.allSettled(this.preparations.values());
  }
}
