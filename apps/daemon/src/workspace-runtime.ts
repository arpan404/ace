import { commandNotDispatched } from "./command-not-dispatched.ts";
import { DefaultBranches } from "./default-branch.ts";
import type { createWritingCli } from "./source-control-cli.ts";
import {
  SourceControlContext,
  SourceControlDraftInput,
  type SourceControlSelection,
} from "@ace/protocol";
import { prBasePreparation, prReviewContext, type PrRemotes } from "./pr-worktree-resolution.ts";
import { readPrConflicts, runPrConflictStep } from "./pr-conflicts.ts";
import type { ForgePrStatus, ForgeRepository } from "@ace/protocol";
import type { CreationWorkspace } from "./creation-workspace.ts";
import { decodeProjectRow, projectSelect } from "./project-storage.ts";
import type { CreationProgress } from "./creation-progress.ts";
import { CreationDrafts } from "./creation-drafts.ts";
import { clearWorkspaceChange, settleWorkspaceChange } from "./workspace-change-clear.ts";
import { threadCleaning, initializeThreadCleanup } from "./thread-cleanup-journal.ts";
import type { WorkspaceChangeReservation } from "./engine/workspace-change.ts";
import { moveThread } from "./thread-move.ts";
import { WorkspaceRoots, type WorkspaceGit } from "./workspace-roots.ts";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { providerNotice } from "@ace/projection";
import { existsSync } from "node:fs";
import { GitError, GitService, type GitOptions } from "@ace/git";
import { TerminalManager, type Terminal, type TerminalManagerOptions } from "@ace/terminal";
import {
  gitStatusLimit,
  TerminalDescriptor,
  ThreadId,
  type Command,
  type CommandResult,
  type ThreadDetails,
  type WorkspaceActionRequest,
  type WorkspaceActionResult,
} from "@ace/protocol";
import { listScripts, installedEditors, shellQuote } from "./workspace-scripts.ts";
import { createCommandRunner, type CommandRunner } from "@ace/forge";
import { pushWorkspace } from "./workspace-push.ts";
import { actionErrorCode, rejectedRemoteHead } from "./action-errors.ts";
import { WorkspaceForge } from "./workspace-forge.ts";
import { RunCheckpoints } from "./run-checkpoints.ts";
import { listClientRuns } from "./run-client-storage.ts";
import { AsyncCommands } from "./async-commands.ts";
import type { Store } from "./store.ts";
import { systemCredentials } from "./credential-runtime.ts";

export interface WorkspaceRuntimeOptions {
  sourceControl?: import("./source-control.ts").SourceControl;
  git?: GitOptions;
  writingCli?: ReturnType<typeof createWritingCli>;
  reconcileThread?(id: ThreadId): Promise<void>;
  changeWorkspace?(
    id: ThreadId,
    commandId: string,
    effect: () => Promise<ThreadDetails>,
    reservation: WorkspaceChangeReservation,
    commit?: () => void,
  ): Promise<void>;
  forgeRunner?: (cwd: string) => CommandRunner;
  /** Injected endpoint selection for isolated Git fixtures; production matches repository identity. */
  prRemote?: (remotes: PrRemotes, repository: ForgeRepository) => string;
  gitService?: WorkspaceGit;
  /** How long a remote worktree base's fetch may take; 15 s by default. */
  baseFetchTimeoutMs?: number;
  /**
   * How long read-only work before `git worktree add` may take; 10 minutes by default.
   * `ACE_WORKTREE_PREPARATION_TIMEOUT_MS` or the `worktree.preparationTimeoutMs` setting
   * overrides it when no explicit value is given.
   */
  preparationTimeoutMs?: number;
  terminal?: TerminalManagerOptions;
  /** A handle identifies one shell lifetime, including across daemon restarts. */
  terminalId?: () => string;
  editorPath?: string;
  editorApplications?: readonly string[];
  platform?: NodeJS.Platform;
  machine?: { host: string; name: string };
  /** Reports failures nobody waits on: background worktree cleanup and its recovery. */
  log?: (message: string, error: unknown) => void;
}
export class WorkspaceRuntime {
  readonly creationDrafts: CreationDrafts;
  readonly git: WorkspaceGit;
  readonly forge: WorkspaceForge;
  private defaultBranches: DefaultBranches;
  readonly commands: AsyncCommands;
  readonly checkpoints: RunCheckpoints;
  readonly machine: { host: string; name: string };
  private store: Store;
  private roots: WorkspaceRoots;
  private now: () => number;
  private options: WorkspaceRuntimeOptions;
  private prLifetime = new AbortController();
  private manager: TerminalManager;
  private terminals = new Map<string, { threadId: ThreadId; terminal: Terminal }>();
  private pendingOpens = 0;
  private opened = new Set<(threadId: ThreadId, terminalId: string) => void>();
  private terminalId: () => string;
  private writing = new Set<AbortController>();
  /** Threads whose checkout move is running in this daemon now. */
  private changing = new Set<ThreadId>();
  constructor(
    store: Store,
    directory: string,
    now: () => number,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.store = store;
    initializeThreadCleanup(store);
    this.now = now;
    this.options = options;
    this.terminalId = options.terminalId ?? systemCredentials.id;
    this.machine = options.machine ?? { host: hostname(), name: hostname() };
    this.git = options.gitService ?? new GitService(options.git);
    this.defaultBranches = new DefaultBranches(now);
    this.forge = new WorkspaceForge(
      store,
      this.git,
      now,
      options.forgeRunner ?? ((cwd) => createCommandRunner({ cwd })),
      options.sourceControl,
    );
    this.roots = new WorkspaceRoots(store, this.git, directory, now, this.machine, {
      ...(options.baseFetchTimeoutMs ? { baseFetchTimeoutMs: options.baseFetchTimeoutMs } : {}),
      ...(options.sourceControl ? { sourceControl: options.sourceControl } : {}),
      creation: {
        ...(options.preparationTimeoutMs
          ? { preparationTimeoutMs: options.preparationTimeoutMs }
          : {}),
        ...(options.log ? { log: options.log } : {}),
      },
      preparePr: prBasePreparation({
        git: this.git,
        signal: this.prLifetime.signal,
        timeoutMs: options.baseFetchTimeoutMs ?? 15000,
        detail: (project, selection, signal) =>
          this.forge.checkoutDetail(project, selection, signal),
        checkout: (project, selection, signal) => this.forge.checkout(project, selection, signal),
        ...(options.prRemote ? { remote: options.prRemote } : {}),
        ...(options.sourceControl
          ? { hostAliases: options.sourceControl.hostAliases.bind(options.sourceControl) }
          : {}),
      }),
    });
    this.creationDrafts = new CreationDrafts(store, now, {
      ready: () => this.roots.creationReady(),
      cleanupComplete: (command) => this.roots.creationCleanupComplete(command),
      discard: (command) => this.roots.discardCreation(command),
    });
    this.commands = new AsyncCommands(store);
    this.checkpoints = new RunCheckpoints(store, this.git, (id) => this.root(id), now);
    this.manager = new TerminalManager({ scrollbackBytes: 262144, ...options.terminal });
  }
  /** Live-update the worktree preparation deadline from settings; the next start uses it. */
  setPreparationTimeoutMs(timeoutMs: number): void {
    this.roots.setPreparationTimeoutMs(timeoutMs);
  }
  /** The selected remote's HEAD, else the forge's default branch, else Git's local guess. */
  private async defaultBranch(root: string, guess: string): Promise<string> {
    const remote = (await this.options.sourceControl?.preferences())?.remote ?? "origin";
    return this.defaultBranches.resolve(JSON.stringify([root, remote]), {
      remote: () => this.git.remoteDefaultBranch({ repo: root, remote, timeoutMs: 5_000 }),
      forge: () => this.forge.defaultBranch(root),
      local: async () => guess,
    });
  }
  root(id: ThreadId): string {
    return this.roots.root(id);
  }
  /** Late preparation; `runCommands` false (Read-only access) skips the setup script. */
  async prepare(
    id: ThreadId,
    policy: { runCommands: boolean } = { runCommands: true },
  ): Promise<string> {
    if (this.options.git?.processRuntime?.cleanupSupervisor) {
      const thread = this.store.getThread(id);
      const project = thread && this.store.getWorkspacePath(thread.workspaceId);
      if (project) await this.git.recoverCleanup(project);
    }
    const root = await this.roots.prepare(id, policy);
    if (this.options.git?.processRuntime?.cleanupSupervisor) await this.git.recoverCleanup(root);
    await this.git.assertMutationAvailable(root);
    return root;
  }
  /**
   * Startup hygiene: retire the definitively stale Git mutation leases of every registered
   * project. A lease whose owner may be alive, or whose checkout still exists, is left fencing.
   */
  async sweepStaleLeases(failed: (path: string, error: unknown) => void): Promise<void> {
    const rows = this.store
      .statement(
        "SELECT path FROM workspaces WHERE NOT EXISTS(SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY id",
      )
      .all();
    for (const row of rows) {
      const path = String(row.path);
      try {
        await this.git.heal(path);
      } catch (error) {
        failed(path, error);
      }
    }
  }
  /**
   * Self-healing for checkout moves: settle every move a restart interrupted, or whose failure
   * left its outcome uncertain, once Git reports its roots free. Runs at startup and with the
   * periodic lock sweep, so a fence never needs a person to clear it.
   */
  async settleWorkspaceChanges(failed: (id: ThreadId, error: unknown) => void): Promise<void> {
    for (const id of this.store.workspaceReservations.fencedThreads()) {
      try {
        await this.settleWorkspaceChange(id);
      } catch (error) {
        failed(id, error);
      }
    }
  }
  private settleWorkspaceChange(id: ThreadId): Promise<boolean> {
    return settleWorkspaceChange(this.store, this.git, id, this.now, (owner) =>
      this.changing.has(owner),
    );
  }
  /** Before a new attempt: best effort, as the attempt re-fences whatever is still held. */
  private async settleBeforeAttempt(id: ThreadId): Promise<void> {
    if (this.changing.has(id)) return;
    try {
      await this.settleWorkspaceChange(id);
    } catch (error) {
      this.options.log?.("Checkout move could not be settled", error);
    }
  }
  /** Every checkout move goes through here, so a running one is never settled as stale. */
  private async changeWorkspace(
    ...args: Parameters<NonNullable<WorkspaceRuntimeOptions["changeWorkspace"]>>
  ): Promise<void> {
    const change = this.options.changeWorkspace;
    if (!change) throw new Error("engine_unavailable");
    const [id] = args;
    // The next attempt settles what an earlier, interrupted one left behind.
    await this.settleBeforeAttempt(id);
    if (this.changing.has(id)) throw new Error("workspace_change_in_progress");
    this.changing.add(id);
    try {
      await change(...args);
    } finally {
      this.changing.delete(id);
    }
  }
  /**
   * "Clear stale lock" for a thread: its checkout when it has one, and its project, whose journal
   * fences a worktree that couldn't be created. Reports how many locks it actually retired.
   */
  private async clearLock(threadId: ThreadId): Promise<Omit<CommandResult, "commandId">> {
    const thread = this.store.getThread(threadId);
    if (!thread) return { ok: false, error: "thread_not_found" };
    const project = this.store.getWorkspacePath(thread.workspaceId);
    const binding = this.store.executionWorkspace(threadId);
    return this.clearLocks([binding.path, project].filter((path) => path !== undefined));
  }
  /**
   * The one "Clear stale lock" path, for a thread's roots or a project's repository: retires what
   * it can, reports how many it retired and what still holds one, then runs the worktree
   * cleanups a lock held back.
   */
  private async clearLocks(paths: readonly string[]): Promise<Omit<CommandResult, "commandId">> {
    let cleared = 0;
    let blocked: string | undefined;
    for (const path of new Set(paths)) {
      if (!existsSync(path)) continue;
      const result = await this.git.clearStaleLeases(path);
      cleared += result.retired.length;
      if (result.state.status !== "available") blocked ??= result.message;
    }
    if (blocked)
      return { ok: false, error: "git_quarantined", detail: blocked, locksCleared: cleared };
    await this.roots.retryCreationCleanup();
    return { ok: true, locksCleared: cleared };
  }
  prepareAgentCreation(command: Command, signal: AbortSignal) {
    return this.roots.prepareAgentCreation(command, signal);
  }
  prepareCreation(command: Command, progress?: CreationProgress, signal?: AbortSignal) {
    return this.roots.prepareCreation(command, progress, signal);
  }
  localCreation(command: Command) {
    return this.roots.localCreation(command);
  }
  /** Whether a failed start left nothing to clean up, after any background cleanup ends. */
  creationCleanupSettled(command: Command): Promise<boolean> {
    return this.roots.creationCleanupSettled(command);
  }
  /** "Clear stale lock" for a project, then the worktree cleanups that lock held back. */
  clearProjectLock(path: string): Promise<Omit<CommandResult, "commandId">> {
    return this.clearLocks([path]);
  }
  details(id: ThreadId): Promise<ThreadDetails> {
    return this.roots.details(id);
  }
  listTerminals(id: ThreadId) {
    return [...this.terminals]
      .filter(([, entry]) => entry.threadId === id)
      .map(([key]) => this.describe(key, id));
  }
  /** Hear about every terminal opened from now on (actions and scripts included). */
  onTerminalOpened(listener: (threadId: ThreadId, terminalId: string) => void): () => void {
    this.opened.add(listener);
    return () => this.opened.delete(listener);
  }
  /** Threads with an open terminal, where a person may commit outside any agent turn. */
  terminalThreads(): ThreadId[] {
    return [...new Set([...this.terminals.values()].map((entry) => entry.threadId))];
  }
  hasOwnedWork(id: ThreadId): boolean {
    return this.liveTerminalCount(id) > 0;
  }
  /** Include retained job groups even when their shell has exited. */
  liveTerminalCount(id: ThreadId): number {
    let count = 0;
    for (const entry of this.terminals.values())
      if (entry.threadId === id && entry.terminal.ownsProcesses) count++;
    return count;
  }
  /** Release shells that exited, including ones killed outside ace. */
  async reconcileTerminals(id: ThreadId): Promise<void> {
    for (const [key, entry] of this.terminals)
      if (entry.threadId === id && !terminalAlive(entry.terminal))
        await this.closeTerminal(key, id);
  }
  async closeThreadTerminals(id: ThreadId): Promise<void> {
    for (const [key, entry] of this.terminals)
      if (entry.threadId === id) await this.closeTerminal(key, id);
  }
  terminal(id: string, threadId: ThreadId): Terminal {
    this.root(threadId);
    const entry = this.terminals.get(id);
    if (!entry || entry.threadId !== threadId) throw new Error("terminal_not_found");
    return entry.terminal;
  }
  describe(id: string, threadId: ThreadId) {
    const value = this.terminal(id, threadId).info();
    return TerminalDescriptor.parse({
      id,
      threadId,
      name: value.name,
      pid: value.pid,
      exited: value.exit !== null,
      oldestOffset: value.oldestOffset,
      nextOffset: value.nextOffset,
    });
  }
  async openTerminal(threadId: ThreadId, name: string, cols = 80, rows = 24): Promise<string> {
    if (threadCleaning(this.store, threadId)) throw new Error("thread_deleting");
    for (const [key, entry] of this.terminals)
      if (!terminalAlive(entry.terminal)) {
        await this.manager.release(entry.terminal);
        this.terminals.delete(key);
      }
    if (this.terminals.size + this.pendingOpens >= 256) throw new Error("terminal_limit");
    this.pendingOpens++;
    try {
      const terminal = this.manager.openTerminal({ cwd: this.root(threadId), name, cols, rows });
      const id = `terminal-${this.terminalId()}`;
      this.terminals.set(id, { threadId, terminal });
      for (const listener of this.opened)
        try {
          listener(threadId, id);
        } catch {
          // A watcher's failure never fails the terminal.
        }
      return id;
    } finally {
      this.pendingOpens--;
    }
  }
  async closeTerminal(id: string, threadId: ThreadId): Promise<void> {
    const terminal = this.terminal(id, threadId);
    await this.manager.release(terminal);
    this.terminals.delete(id);
  }
  async read(
    request: WorkspaceActionRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<WorkspaceActionResult> {
    const op = request.operation;
    const wrap = (result: WorkspaceActionResult["result"]): WorkspaceActionResult => ({
      type: "workspace.result",
      requestId: request.requestId,
      result,
    });
    if (
      op.op === "forge.pr.lifecycle" ||
      op.op === "forge.issue.list" ||
      op.op === "forge.issue.detail" ||
      op.op === "forge.issue.timeline" ||
      op.op === "forge.issue.actions" ||
      op.op === "forge.pr.merge-state" ||
      op.op === "forge.pr.stack" ||
      op.op === "forge.pr.stack-memberships" ||
      op.op === "forge.pr.review-state" ||
      op.op === "forge.pr.activity" ||
      op.op === "forge.pr.list" ||
      op.op === "forge.open-work" ||
      op.op === "forge.pr.detail" ||
      op.op === "forge.pr.commits" ||
      op.op === "forge.pr.files" ||
      op.op === "forge.pr.check" ||
      op.op === "forge.file.content"
    ) {
      if (
        op.op === "forge.pr.stack" &&
        op.threadId &&
        this.store.getThread(op.threadId)?.workspaceId !== op.workspaceId
      )
        throw new Error("workspace_not_found");
      const root =
        op.op === "forge.pr.stack" && op.threadId
          ? this.root(op.threadId)
          : this.store.getWorkspacePath(op.workspaceId);
      if (!root) throw new Error("workspace_not_found");
      return wrap({ kind: "forge", data: await this.forge.browse(root, op, signal) });
    }
    if (op.op === "git.draft.cancel") return wrap({ kind: "draftCancelled" });
    if (op.op === "git.draft.context")
      return wrap({
        kind: "draftContext",
        context: await this.draftContext(op.threadId, op.selection),
      });
    if (op.op === "git.draft.generate") {
      if (this.writing.size >= 4) throw new Error("draft_busy");
      const input = SourceControlDraftInput.parse(op.input);
      const lifetime = new AbortController();
      this.writing.add(lifetime);
      const stop = () => lifetime.abort();
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      try {
        lifetime.signal.throwIfAborted();
        const root = this.root(op.threadId);
        const context = await this.draftContext(op.threadId, input.selection);
        if (context.fingerprint !== input.fingerprint) throw new Error("draft_changes_moved");
        const page =
          input.selection.kind === "pr"
            ? this.store.readBoundedItemPage(op.threadId, this.store.headSeq() + 1, 12, 8192)
            : undefined;
        const messages =
          page?.items.flatMap((item) =>
            item.type === "message" &&
            ["user", "assistant"].includes(item.role) &&
            !providerNotice(item)
              ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          ) ?? [];
        const threadContext = [this.store.getThread(op.threadId)?.title ?? "", ...messages]
          .join("\n")
          .slice(-8192);
        if (!this.options.writingCli) throw new Error("draft_provider_unavailable");
        const draft = await this.options.writingCli(input, context, threadContext, lifetime.signal);
        lifetime.signal.throwIfAborted();
        if (
          this.root(op.threadId) !== root ||
          (await this.draftContext(op.threadId, input.selection)).fingerprint !==
            context.fingerprint
        )
          throw new Error("draft_changes_moved");
        return wrap({ kind: "draft", draft, context });
      } catch (error) {
        // Whatever a cancelled generation was doing (reading Git, waiting on the model), the
        // person cancelled it: an abort error is not an action failure.
        if (lifetime.signal.aborted) throw new Error("draft_cancelled", { cause: error });
        throw error;
      } finally {
        signal?.removeEventListener("abort", stop);
        this.writing.delete(lifetime);
      }
    }
    if (op.op === "editors.list")
      return wrap({
        kind: "editors",
        editors: await installedEditors(
          this.options.editorPath ?? process.env.PATH,
          this.options.platform ?? process.platform,
          this.options.editorApplications ?? ["/Applications", join(homedir(), "Applications")],
        ),
      });
    if (op.op === "workspaces.list")
      return this.store.atomic((db) => {
        const rows = db
          .prepare(
            `${projectSelect} WHERE w.id>? AND NOT EXISTS (SELECT 1 FROM workspace_unregistered WHERE workspace_id=w.id) ORDER BY w.id LIMIT ?`,
          )
          .all(op.after ?? "", op.limit + 1);
        const result = wrap({
          kind: "workspaces",
          workspaces: rows.slice(0, op.limit).map(decodeProjectRow),
          ...(rows.length > op.limit ? { next: String(rows[op.limit - 1]?.id) } : {}),
        });
        return result;
      });
    if (op.op === "branches.list") {
      const root = this.store.getWorkspacePath(op.workspaceId);
      if (!root) throw new Error("workspace_not_found");
      const [listed, refs, unbornHead] = await Promise.all([
        this.git.branches(root),
        this.git.branchRefs(root),
        this.git.resolveCommit({ worktree: root, ref: "HEAD" }).then(
          () => false,
          (error: unknown) => {
            if (error instanceof GitError && error.code === "unborn_head") return true;
            throw error;
          },
        ),
      ]);
      return wrap({
        kind: "branches",
        ...listed,
        refs: refs.refs,
        defaultBranch: await this.defaultBranch(root, refs.defaultBranch),
        unbornHead,
      });
    }
    if (op.op === "scripts.list")
      return wrap({ kind: "scripts", scripts: await listScripts(this.root(op.threadId)) });
    if (op.op === "runs.list")
      return this.store.atomic((db) =>
        wrap({ kind: "runs", ...listClientRuns(db, op.threadId, op.before, op.limit) }),
      );
    if (op.op === "thread.details")
      return wrap({ kind: "details", details: await this.details(op.threadId) });
    if (op.op === "git.conflicts") {
      const held = this.reviewedPullRequest(op.threadId);
      const conflicts = await readPrConflicts(
        { git: this.git, cwd: this.root(op.threadId), held },
        op.pr,
      );
      return wrap({ kind: "gitConflicts", conflicts });
    }
    if (op.op === "git.diff") {
      const root = this.root(op.threadId);
      const diff = await this.git.diff({
        worktree: root,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
        maxPatchBytes: 262144,
      });
      if (this.root(op.threadId) !== root) throw new Error("workspace_root_changed");
      return wrap({ kind: "gitDiff", patch: diff.patch, truncated: diff.truncated });
    }
    if (op.op === "git.status") {
      const root = this.root(op.threadId);
      const { files, truncated } = await this.git.changedFiles(root, gitStatusLimit);
      // A commit made after this read must not reuse an older HEAD as its expected one.
      const head = await this.git.resolveCommit({ worktree: root, ref: "HEAD" }).catch(() => null);
      // The same decision `git.commit` applies through `asReviewer`.
      const hooks = this.reviewedPullRequest(op.threadId)
        ? await this.git.reviewerHooks(root)
        : "run";
      return wrap({ kind: "gitStatus", truncated, files, head, hooks });
    }
    return wrap({
      kind: "pr",
      status: await this.forge.status(op.threadId, this.root(op.threadId)),
    });
  }
  /**
   * The pull request the thread's checkout holds, when it works in a PR review worktree (the
   * same rule that keeps such checkouts protected). Changing workspace drops the binding.
   */
  private reviewedPullRequest(id: ThreadId) {
    const details = this.store.getThread(id)?.details;
    return details?.pullRequestWorkspace && details.worktree
      ? details.pullRequestWorkspace
      : undefined;
  }
  async draftContext(id: ThreadId, selection: SourceControlSelection) {
    const root = this.root(id);
    const context = SourceControlContext.parse(await this.git.writingContext(root, selection));
    if (this.root(id) !== root) throw new Error("workspace_root_changed");
    return context;
  }
  execute(
    command: Command,
    allowed: () => boolean = allowLocalAction,
    progress?: CreationProgress,
  ): Promise<CommandResult> {
    return this.commands.run(command, async () => {
      if (!allowed()) return commandNotDispatched(command, "forbidden");
      const p = command.payload;
      if (p.type === "forge.hosted.lifecycle") {
        const cwd = this.store.getWorkspacePath(p.workspaceId);
        if (!cwd) return { ok: false, error: "workspace_not_found" };
        return this.forge.hostedLifecycle({ ...command, payload: p }, cwd, allowed);
      }
      if (p.type === "forge.issue.write" || p.type === "forge.issue.reconcile") {
        const cwd = this.store.getWorkspacePath(p.workspaceId);
        if (!cwd) return commandNotDispatched(command, "workspace_not_found");
        return this.forge.issueCommand(command, cwd, allowed);
      }
      if (p.type === "forge.hosted.review") {
        const cwd = this.store.getWorkspacePath(p.workspaceId);
        if (!cwd) return { ok: false, error: "workspace_not_found" };
        return this.forge.hostedReview({ ...command, payload: p }, cwd, allowed);
      }
      if (p.type === "forge.hosted.merge") {
        const cwd = this.store.getWorkspacePath(p.workspaceId);
        if (!cwd) return commandNotDispatched(command, "workspace_not_found");
        return this.forge.hostedMerge({ ...command, payload: p }, cwd, allowed);
      }
      if (p.type === "forge.hosted.checks") {
        const cwd = this.store.getWorkspacePath(p.workspaceId);
        if (!cwd) return { ok: false, error: "workspace_not_found" };
        return this.forge.hostedChecks({ ...command, payload: p }, cwd, allowed);
      }
      const id = "threadId" in p ? p.threadId : "link" in p ? p.link.threadId : undefined;
      if (!id) throw new Error("invalid_command");
      const threadId = ThreadId.parse(id);
      if (threadCleaning(this.store, threadId)) return { ok: false, error: "thread_deleting" };
      if (p.type === "forge.pr.worktree")
        return this.git.nonExecuting(() => this.workOnPr(command, threadId, allowed, progress));
      if (p.type === "thread.move") {
        await this.reconcileTerminals(threadId);
        await this.options.reconcileThread?.(threadId);
        // A move an earlier restart interrupted no longer holds the thread where it is.
        await this.settleBeforeAttempt(threadId);
        return moveThread(
          this.store,
          command,
          this.now,
          (owner) => this.hasOwnedWork(owner),
          this.options.changeWorkspace ? (...args) => this.changeWorkspace(...args) : undefined,
          allowed,
        );
      }
      if (p.type === "thread.workspace.set") {
        if (!this.options.changeWorkspace) return { ok: false, error: "engine_unavailable" };
        await this.reconcileTerminals(threadId);
        if (this.hasOwnedWork(threadId)) return { ok: false, error: "terminal_owned" };
        const reservation = await this.roots.changeRoots(threadId, p);
        await this.changeWorkspace(
          threadId,
          command.id,
          async () => {
            if (!allowed()) throw new Error("forbidden");
            const details = await this.roots.change(threadId, p);
            if (!allowed()) throw new Error("forbidden");
            return details;
          },
          { ...reservation, hasOwnedWork: (owner) => this.hasOwnedWork(owner) },
        );
        return { ok: true, threadId };
      }
      if (p.type === "thread.workspace.setup") {
        if (!allowed()) return { ok: false, error: "forbidden" };
        const refused = this.roots.chooseSetup(threadId, p.action);
        return refused ? { ok: false, error: refused } : { ok: true, threadId };
      }
      if (p.type === "thread.workspace.clear") {
        if (!allowed()) return { ok: false, error: "forbidden" };
        return clearWorkspaceChange(this.store, this.git, threadId, this.now);
      }
      if (p.type === "git.lock.clear") return this.clearLock(threadId);
      const cwd = this.root(threadId);
      if (p.type === "forge.issue.link") return this.forge.issueCommand(command, cwd, allowed);
      // The person's own commit and push run their hooks and signing, as their Git would.
      const review = this.reviewedPullRequest(threadId);
      const asPerson = <T>(operation: () => Promise<T>) =>
        review ? this.git.asReviewer(operation) : this.git.asPerson(operation);
      if (p.type === "git.conflicts")
        return runPrConflictStep(
          {
            git: this.git,
            cwd,
            held: review,
            remote: this.options.prRemote,
            hostAliases: this.options.sourceControl?.hostAliases.bind(this.options.sourceControl),
            allowed: () => {
              if (!allowed()) throw new Error("forbidden");
            },
            signal: this.prLifetime.signal,
          },
          p.pr,
          p.step,
        );
      if (p.type === "git.commit")
        return {
          ok: true,
          commit: await asPerson(() =>
            this.git.commit({
              worktree: cwd,
              message: p.message,
              expectedHead: p.expectedHead,
              paths: p.paths,
              draftFingerprint: p.draftFingerprint,
            }),
          ),
        };
      if (p.type === "git.push") {
        try {
          // Only the push itself is the person's; reading the checkout stays ace's own.
          const git = {
            push: (options: Parameters<WorkspaceGit["push"]>[0]) =>
              asPerson(() => this.git.push(options)),
            repositoryInfo: (path: string) => this.git.repositoryInfo(path),
          };
          await pushWorkspace(git, this.options.sourceControl, cwd, p, allowed, review);
        } catch (error) {
          const remoteHead = rejectedRemoteHead(error);
          if (!remoteHead) throw error;
          return { ok: false, error: actionErrorCode(error), remoteHead };
        }
        return { ok: true };
      }
      if (p.type === "workspace.editor.open") {
        const editor = (
          await installedEditors(
            this.options.editorPath ?? process.env.PATH,
            this.options.platform ?? process.platform,
            this.options.editorApplications ?? ["/Applications", join(homedir(), "Applications")],
          )
        ).find((entry) => entry.id === p.editorId);
        if (!editor) throw new Error("editor_not_found");
        if (!allowed()) return { ok: false, error: "forbidden" };
        return { ok: true, editor: { editor, path: cwd } };
      }
      if (p.type === "workspace.script.run") {
        const script = (await listScripts(cwd)).find((entry) => entry.id === p.scriptId);
        if (!script) throw new Error("script_not_found");
        if ((this.options.platform ?? process.platform) === "win32")
          throw new Error("script_shell_unsupported");
        if (!allowed()) return { ok: false, error: "forbidden" };
        const terminalId = await this.openTerminal(threadId, script.name);
        this.terminal(terminalId, threadId).write(
          `exec /bin/sh -c ${shellQuote(script.command)}\r`,
        );
        return { ok: true, terminalId };
      }
      return this.forge.execute(p, cwd, allowed);
    });
  }
  private async workOnPr(
    command: Command,
    id: ThreadId,
    allowed: () => boolean,
    progress?: CreationProgress,
  ): Promise<Omit<CommandResult, "commandId">> {
    const p = command.payload;
    if (p.type !== "forge.pr.worktree") throw new Error("invalid_command");
    if (!this.options.changeWorkspace) throw new Error("engine_unavailable");
    await this.reconcileTerminals(id);
    await this.options.reconcileThread?.(id);
    if (this.hasOwnedWork(id)) throw new Error("terminal_owned");
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    const project = this.store.getWorkspacePath(thread.workspaceId);
    if (!project) throw new Error("workspace_not_found");
    const current = thread.details?.worktree ?? project;
    const selection = p.pullRequest;
    const previous = thread.details?.pullRequestWorkspace;
    let prepared: CreationWorkspace | undefined;
    let prStatus: ForgePrStatus | undefined;
    try {
      await this.changeWorkspace(
        id,
        command.id,
        async () => {
          if (!allowed()) throw new Error("forbidden");
          if (
            previous &&
            JSON.stringify(previous.ref) === JSON.stringify(selection.ref) &&
            previous.headSha === selection.headSha &&
            thread.details?.workspaceChange?.state !== "preparing" &&
            !thread.details?.workspaceChange?.uncertain
          ) {
            const signal = progress?.controller.signal ?? this.prLifetime.signal;
            const detail = await this.forge.checkoutDetail(project, selection, signal);
            const latest = await this.forge.checkout(project, selection, signal);
            if (
              latest.baseSha === detail.baseSha &&
              latest.baseBranch === detail.baseBranch &&
              latest.headBranch === detail.headBranch &&
              (await this.git.resolveCommit({ worktree: current, ref: "HEAD" })) ===
                selection.headSha
            ) {
              signal.throwIfAborted();
              if (!allowed()) throw new Error("forbidden");
              prStatus = detail.status;
              return {
                ...this.store.getThread(id)?.details,
                mode: "worktree",
                worktree: current,
                head: selection.headSha,
                pullRequestWorkspace: { ...latest, ...prReviewContext(detail) },
                machine: this.machine,
              };
            }
          }
          prepared = await this.roots.prepareExistingPr(command, progress);
          await prepared.verify?.();
          if (!allowed()) throw new Error("forbidden");
          const value = prepared.workspace;
          prStatus = value.prStatus;
          return {
            ...this.store.getThread(id)?.details,
            mode: "worktree",
            worktree: value.path,
            branch: value.branch,
            head: selection.headSha,
            pullRequestWorkspace: value.pullRequestWorkspace,
            machine: this.machine,
          };
        },
        // A pull request checks out into a new worktree: no shared checkout is rewritten.
        {
          roots: [current, project],
          writes: [],
          hasOwnedWork: (owner) => this.hasOwnedWork(owner),
        },
        () => {
          if (!prStatus) throw new Error("forge_recovery_unavailable");
          this.forge.admitCheckout(id, prStatus);
        },
      );
      return { ok: true, threadId: id, pr: selection.ref };
    } finally {
      await prepared?.release();
    }
  }
  private closed: Promise<void> | undefined;
  /** Idempotent: a second close (e.g. a cleanup path after shutdown) does not touch SQLite again. */
  close(): Promise<void> {
    this.closed ??= this.shutdown();
    return this.closed;
  }
  private async shutdown(): Promise<void> {
    for (const lifetime of this.writing) lifetime.abort();
    this.prLifetime.abort();
    this.forge.close();
    await this.roots.close();
    await this.commands.drained();
    await this.checkpoints.close();
    await this.manager.closeAll();
    this.terminals.clear();
    await this.git.close();
  }
}

function allowLocalAction(): boolean {
  return true;
}

function terminalAlive(terminal: Terminal): boolean {
  try {
    if (terminal.info().exit !== null) return false;
    process.kill(terminal.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists under another owner; only ESRCH proves it is gone.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
