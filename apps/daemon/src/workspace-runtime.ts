import { createHash } from "node:crypto";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { GitService, type GitOptions } from "@ace/git";
import { TerminalManager, type Terminal, type TerminalManagerOptions } from "@ace/terminal";
import {
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
import { WorkspaceForge } from "./workspace-forge.ts";
import { RunCheckpoints } from "./run-checkpoints.ts";
import { listClientRuns } from "./run-client-storage.ts";
import { AsyncCommands } from "./async-commands.ts";
import type { Store } from "./store.ts";

export interface WorkspaceRuntimeOptions {
  git?: GitOptions;
  terminal?: TerminalManagerOptions;
  editorPath?: string;
  editorApplications?: readonly string[];
  platform?: NodeJS.Platform;
  machine?: { host: string; name: string };
}
export class WorkspaceRuntime {
  readonly git: GitService;
  readonly forge: WorkspaceForge;
  readonly commands: AsyncCommands;
  readonly checkpoints: RunCheckpoints;
  readonly machine: { host: string; name: string };
  private store: Store;
  private directory: string;
  private now: () => number;
  private options: WorkspaceRuntimeOptions;
  private manager: TerminalManager;
  private terminals = new Map<string, { threadId: ThreadId; terminal: Terminal }>();
  private pendingOpens = 0;
  private nextTerminal = 0;
  constructor(
    store: Store,
    directory: string,
    now: () => number,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.store = store;
    this.directory = directory;
    this.now = now;
    this.options = options;
    this.machine = options.machine ?? { host: hostname(), name: hostname() };
    this.git = new GitService(options.git);
    this.forge = new WorkspaceForge(store, this.git, now);
    this.commands = new AsyncCommands(store);
    this.checkpoints = new RunCheckpoints(store, this.git, (id) => this.root(id), now);
    this.manager = new TerminalManager({ scrollbackBytes: 262144, ...options.terminal });
  }
  root(id: ThreadId): string {
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    const root = thread.details?.worktree ?? this.store.getWorkspacePath(thread.workspaceId);
    if (!root) throw new Error("workspace_not_found");
    return root;
  }
  async prepare(id: ThreadId): Promise<string> {
    const thread = this.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    const root = this.store.getWorkspacePath(thread.workspaceId);
    if (!root) throw new Error("workspace_not_found");
    if (thread.details?.mode !== "worktree") return root;
    const key = createHash("sha256").update(id).digest("hex");
    const path = join(this.directory, "worktrees", key);
    const branch = `ace/${key.slice(0, 24)}`;
    const existing = (await this.git.listWorktrees(root)).find(
      (tree) => tree.path === path && tree.branch === branch,
    );
    if (!existing) {
      await mkdir(join(this.directory, "worktrees"), { recursive: true, mode: 0o700 });
      await this.git.createWorktree({
        repo: root,
        path,
        baseRef: thread.details?.baseBranch ?? "HEAD",
        branch,
      });
    }
    this.store.appendEvents(
      id,
      [
        {
          type: "thread.client.updated",
          changes: {
            details: { ...thread.details, worktree: path, branch, machine: this.machine },
          },
        },
      ],
      this.now(),
    );
    return path;
  }
  async details(id: ThreadId): Promise<ThreadDetails> {
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
    const details: ThreadDetails = {
      ...thread.details,
      worktree: root,
      branch: info.branch,
      head: info.head,
      ahead: info.ahead,
      behind: info.behind,
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
    if (JSON.stringify(thread.details) !== JSON.stringify(details))
      this.store.appendEvents(
        id,
        [{ type: "thread.client.updated", changes: { details } }],
        this.now(),
      );
    return details;
  }
  listTerminals(id: ThreadId) {
    return [...this.terminals]
      .filter(([, entry]) => entry.threadId === id)
      .map(([key]) => this.describe(key, id));
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
          .prepare("SELECT id,name,path FROM workspaces WHERE id>? ORDER BY id LIMIT ?")
          .all(op.after ?? "", op.limit + 1);
        const result = wrap({
          kind: "workspaces",
          workspaces: rows.slice(0, op.limit).map((row) => ({
            id: WorkspaceId.parse(row.id),
            name: String(row.name),
            path: String(row.path),
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
      const cwd = this.root(threadId);
      if (p.type === "git.commit")
        return {
          ok: true,
          commit: await this.git.commit({
            worktree: cwd,
            message: p.message,
            expectedHead: p.expectedHead,
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
