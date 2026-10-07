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
  WorkspaceId,
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

export interface WorkspaceRuntimeOptions {
  git?: GitOptions;
  changeWorkspace?(
    id: ThreadId,
    commandId: string,
    effect: () => Promise<ThreadDetails>,
    reservation: WorkspaceChangeReservation,
    commit?: () => void,
  ): Promise<void>;
  forgeRunner?: (cwd: string) => CommandRunner;
  gitService?: WorkspaceGit;
  terminal?: TerminalManagerOptions;
  editorPath?: string;
  editorApplications?: readonly string[];
  platform?: NodeJS.Platform;
  machine?: { host: string; name: string };
}
export class WorkspaceRuntime {
  readonly git: WorkspaceGit;
  readonly forge: WorkspaceForge;
  readonly commands: AsyncCommands;
  readonly checkpoints: RunCheckpoints;
  readonly machine: { host: string; name: string };
  private store: Store;
  private roots: WorkspaceRoots;
  private now: () => number;
  private options: WorkspaceRuntimeOptions;
  private manager: TerminalManager;
  private terminals = new Map<string, { threadId: ThreadId; terminal: Terminal }>();
  private ownedTerminals = new Map<ThreadId, number>();
  private pendingOpens = 0;
  private nextTerminal = 0;
  constructor(
    store: Store,
    directory: string,
    now: () => number,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.store = store;
    this.now = now;
    this.options = options;
    this.machine = options.machine ?? { host: hostname(), name: hostname() };
    this.git = options.gitService ?? new GitService(options.git);
    this.roots = new WorkspaceRoots(store, this.git, directory, now, this.machine);
    this.forge = new WorkspaceForge(
      store,
      this.git,
      now,
      options.forgeRunner ?? ((cwd) => createCommandRunner({ cwd })),
    );
    this.commands = new AsyncCommands(store);
    this.checkpoints = new RunCheckpoints(store, this.git, (id) => this.root(id), now);
    this.manager = new TerminalManager({ scrollbackBytes: 262144, ...options.terminal });
  }
  root(id: ThreadId): string {
    return this.roots.root(id);
  }
  async prepare(id: ThreadId): Promise<string> {
    const root = await this.roots.prepare(id);
    await this.git.assertMutationAvailable(root);
    return root;
  }
  prepareCreation(command: Command) {
    return this.roots.prepareCreation(command);
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
    return (this.ownedTerminals.get(id) ?? 0) > 0;
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
    if (this.terminals.size + this.pendingOpens >= 64) throw new Error("terminal_limit");
    this.pendingOpens++;
    try {
      const terminal = this.manager.openTerminal({ cwd: this.root(threadId), name, cols, rows });
      const id = `terminal-${++this.nextTerminal}`;
      this.terminals.set(id, { threadId, terminal });
      this.ownedTerminals.set(threadId, (this.ownedTerminals.get(threadId) ?? 0) + 1);
      return id;
    } finally {
      this.pendingOpens--;
    }
  }
  async closeTerminal(id: string, threadId: ThreadId): Promise<void> {
    const terminal = this.terminal(id, threadId);
    await this.manager.release(terminal);
    if (!this.terminals.delete(id)) return;
    const remaining = (this.ownedTerminals.get(threadId) ?? 1) - 1;
    if (remaining > 0) this.ownedTerminals.set(threadId, remaining);
    else this.ownedTerminals.delete(threadId);
  }
  async read(request: WorkspaceActionRequest): Promise<WorkspaceActionResult> {
    const op = request.operation;
    const wrap = (result: WorkspaceActionResult["result"]): WorkspaceActionResult => ({
      type: "workspace.result",
      requestId: request.requestId,
      result,
    });
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
            "SELECT id,name,path FROM workspaces WHERE id>? AND NOT EXISTS (SELECT 1 FROM workspace_unregistered WHERE workspace_id=workspaces.id) ORDER BY id LIMIT ?",
          )
          .all(op.after ?? "", op.limit + 1);
        const result = wrap({
          kind: "workspaces",
          workspaces: rows.slice(0, op.limit).map((row) => ({
            id: WorkspaceId.parse(row.id),
            name: String(row.name),
            path: String(row.path),
            deck: this.store.workspaceDeck(WorkspaceId.parse(row.id)),
          })),
          ...(rows.length > op.limit ? { next: String(rows[op.limit - 1]?.id) } : {}),
        });
        return result;
      });
    if (op.op === "branches.list") {
      const root = this.store.getWorkspacePath(op.workspaceId);
      if (!root) throw new Error("workspace_not_found");
      return wrap({ kind: "branches", ...(await this.git.branches(root)) });
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
  execute(command: Command, allowed: () => boolean = allowLocalAction): Promise<CommandResult> {
    return this.commands.run(command, async () => {
      if (!allowed()) return { ok: false, error: "forbidden" };
      const p = command.payload;
      const id = "threadId" in p ? p.threadId : "link" in p ? p.link.threadId : undefined;
      if (!id) throw new Error("invalid_command");
      const threadId = ThreadId.parse(id);
      if (p.type === "thread.move")
        return moveThread(
          this.store,
          command,
          this.now,
          (owner) => this.hasOwnedWork(owner),
          this.options.changeWorkspace,
          allowed,
        );
      if (p.type === "thread.workspace.set") {
        if (!this.options.changeWorkspace) return { ok: false, error: "engine_unavailable" };
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
  async close(): Promise<void> {
    this.forge.close();
    await this.roots.close();
    await this.commands.drained();
    await this.checkpoints.close();
    await this.manager.closeAll();
    this.terminals.clear();
    this.ownedTerminals.clear();
    await this.git.close();
  }
}

function allowLocalAction(): boolean {
  return true;
}
