import { createWritingCli } from "./source-control-cli.ts";
import {
  SourceControlContext,
  SourceControlDraftInput,
  type SourceControlSelection,
} from "@ace/protocol";
import { prBasePreparation, prReviewContext, type PrRemotes } from "./pr-worktree-resolution.ts";
import type { ForgePrStatus, ForgeRepository } from "@ace/protocol";
import type { CreationWorkspace } from "./creation-workspace.ts";
import { decodeProjectRow } from "./project-storage.ts";
import { CreationDrafts, type CreationProgress } from "./creation-progress.ts";
import { threadCleaning, initializeThreadCleanup } from "./thread-cleanup-journal.ts";
import type { WorkspaceChangeReservation } from "./engine/workspace-change.ts";
import { moveThread } from "./thread-move.ts";
import { WorkspaceRoots, type WorkspaceGit } from "./workspace-roots.ts";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { GitService, type GitOptions } from "@ace/git";
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
import { WorkspaceForge } from "./workspace-forge.ts";
import { RunCheckpoints } from "./run-checkpoints.ts";
import { listClientRuns } from "./run-client-storage.ts";
import { AsyncCommands } from "./async-commands.ts";
import type { Store } from "./store.ts";
import { systemCredentials } from "./credential-runtime.ts";

export interface WorkspaceRuntimeOptions {
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
  terminal?: TerminalManagerOptions;
  /** A handle identifies one shell lifetime, including across daemon restarts. */
  terminalId?: () => string;
  editorPath?: string;
  editorApplications?: readonly string[];
  platform?: NodeJS.Platform;
  machine?: { host: string; name: string };
}
export class WorkspaceRuntime {
  readonly creationDrafts: CreationDrafts;
  readonly git: WorkspaceGit;
  readonly forge: WorkspaceForge;
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
  private terminalId: () => string;
  private writing = new Set<AbortController>();
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
    this.forge = new WorkspaceForge(
      store,
      this.git,
      now,
      options.forgeRunner ?? ((cwd) => createCommandRunner({ cwd })),
    );
    this.roots = new WorkspaceRoots(store, this.git, directory, now, this.machine, {
      ...(options.baseFetchTimeoutMs ? { baseFetchTimeoutMs: options.baseFetchTimeoutMs } : {}),
      preparePr: prBasePreparation({
        git: this.git,
        signal: this.prLifetime.signal,
        timeoutMs: options.baseFetchTimeoutMs ?? 15000,
        detail: (project, selection, signal) =>
          this.forge.checkoutDetail(project, selection, signal),
        checkout: (project, selection, signal) => this.forge.checkout(project, selection, signal),
        ...(options.prRemote ? { remote: options.prRemote } : {}),
      }),
    });
    this.creationDrafts = new CreationDrafts(store, now, {
      ready: () => this.roots.creationReady(),
      cleanupComplete: (command) => this.roots.creationCleanupComplete(command),
    });
    this.commands = new AsyncCommands(store);
    this.checkpoints = new RunCheckpoints(store, this.git, (id) => this.root(id), now);
    this.manager = new TerminalManager({ scrollbackBytes: 262144, ...options.terminal });
  }
  root(id: ThreadId): string {
    return this.roots.root(id);
  }
  async prepare(id: ThreadId): Promise<string> {
    if (this.options.git?.processRuntime?.cleanupSupervisor) {
      const thread = this.store.getThread(id);
      const project = thread && this.store.getWorkspacePath(thread.workspaceId);
      if (project) await this.git.recoverCleanup(project);
    }
    const root = await this.roots.prepare(id);
    if (this.options.git?.processRuntime?.cleanupSupervisor) await this.git.recoverCleanup(root);
    await this.git.assertMutationAvailable(root);
    return root;
  }
  prepareCreation(command: Command, progress?: CreationProgress) {
    return this.roots.prepareCreation(command, progress);
  }
  localCreation(command: Command) {
    return this.roots.localCreation(command);
  }
  details(id: ThreadId): Promise<ThreadDetails> {
    return this.roots.details(id);
  }
  listTerminals(id: ThreadId) {
    return [...this.terminals]
      .filter(([, entry]) => entry.threadId === id)
      .map(([key]) => this.describe(key, id));
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
    if (this.terminals.size + this.pendingOpens >= 64) throw new Error("terminal_limit");
    this.pendingOpens++;
    try {
      const terminal = this.manager.openTerminal({ cwd: this.root(threadId), name, cols, rows });
      const id = `terminal-${this.terminalId()}`;
      this.terminals.set(id, { threadId, terminal });
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
      op.op === "forge.pr.activity" ||
      op.op === "forge.pr.list" ||
      op.op === "forge.pr.detail" ||
      op.op === "forge.pr.commits" ||
      op.op === "forge.pr.files"
    ) {
      const root = this.store.getWorkspacePath(op.workspaceId);
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
            ? this.store.readItemPage(op.threadId, this.store.headSeq() + 1, 12, 8192)
            : undefined;
        const messages =
          page?.items.flatMap((item) =>
            item.type === "message" && ["user", "assistant"].includes(item.role)
              ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
              : [],
          ) ?? [];
        const threadContext = [this.store.getThread(op.threadId)?.title ?? "", ...messages]
          .join("\n")
          .slice(-8192);
        const draft = await (this.options.writingCli ?? createWritingCli())(
          input,
          context,
          threadContext,
          lifetime.signal,
        );
        lifetime.signal.throwIfAborted();
        if (
          this.root(op.threadId) !== root ||
          (await this.draftContext(op.threadId, input.selection)).fingerprint !==
            context.fingerprint
        )
          throw new Error("draft_changes_moved");
        return wrap({ kind: "draft", draft, context });
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
            "SELECT id,name,path,(SELECT icon FROM workspace_metadata WHERE workspace_id=workspaces.id) AS icon,(SELECT default_icon FROM workspace_metadata WHERE workspace_id=workspaces.id) AS defaultIcon FROM workspaces WHERE id>? AND NOT EXISTS (SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY id LIMIT ?",
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
      const [listed, refs] = await Promise.all([
        this.git.branches(root),
        this.git.branchRefs(root),
      ]);
      return wrap({
        kind: "branches",
        ...listed,
        refs: refs.refs,
        defaultBranch: refs.defaultBranch,
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
      const { files, truncated } = await this.git.changedFiles(
        this.root(op.threadId),
        gitStatusLimit,
      );
      return wrap({ kind: "gitStatus", truncated, files });
    }
    return wrap({
      kind: "pr",
      status: await this.forge.status(op.threadId, this.root(op.threadId)),
    });
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
      if (!allowed()) return { ok: false, error: "forbidden" };
      const p = command.payload;
      const id = "threadId" in p ? p.threadId : "link" in p ? p.link.threadId : undefined;
      if (!id) throw new Error("invalid_command");
      const threadId = ThreadId.parse(id);
      if (threadCleaning(this.store, threadId)) return { ok: false, error: "thread_deleting" };
      if (p.type === "forge.pr.worktree")
        return this.workOnPr(command, threadId, allowed, progress);
      if (p.type === "thread.move") {
        await this.reconcileTerminals(threadId);
        await this.options.reconcileThread?.(threadId);
        return moveThread(
          this.store,
          command,
          this.now,
          (owner) => this.hasOwnedWork(owner),
          this.options.changeWorkspace,
          allowed,
        );
      }
      if (p.type === "thread.workspace.set") {
        if (!this.options.changeWorkspace) return { ok: false, error: "engine_unavailable" };
        await this.reconcileTerminals(threadId);
        if (this.hasOwnedWork(threadId)) return { ok: false, error: "terminal_owned" };
        const roots = await this.roots.changeRoots(threadId, p.mode);
        await this.options.changeWorkspace(
          threadId,
          command.id,
          async () => {
            if (!allowed()) throw new Error("forbidden");
            const details = await this.roots.change(threadId, p);
            if (!allowed()) throw new Error("forbidden");
            return details;
          },
          { roots, hasOwnedWork: (owner) => this.hasOwnedWork(owner) },
        );
        return { ok: true, threadId };
      }
      const cwd = this.root(threadId);
      if (p.type === "git.commit")
        return {
          ok: true,
          commit: await this.git.commit({
            worktree: cwd,
            message: p.message,
            expectedHead: p.expectedHead,
            paths: p.paths,
            draftFingerprint: p.draftFingerprint,
          }),
        };
      if (p.type === "git.push") {
        await this.git.push({ worktree: cwd, remote: p.remote });
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
      await this.options.changeWorkspace(
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
        { roots: [current, project], hasOwnedWork: (owner) => this.hasOwnedWork(owner) },
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
  async close(): Promise<void> {
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
