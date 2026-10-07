import { FakeProjects } from "./projects.ts";
import {
  gitStatusLimit,
  ServerMessage,
  type GitStatusFile,
  type WorkspaceActionRequest,
  type CommandPayload,
  type CommandResult,
  type ThreadId,
} from "@ace/protocol";
import { synthesizedStatus } from "./catalog/git-status.ts";
import { scriptOutput } from "./catalog/scripts.ts";
import { FakeForgeWire } from "./forge-wire.ts";
import { FakeTerminals } from "./terminals.ts";
import { fakeBranchRefs } from "./worktree-base.ts";
import type { FakeServiceContext } from "./service-context.ts";
const emptyDiff = { files: 0, additions: 0, deletions: 0 };

export class FakeWorkspaceWire {
  readonly projects: FakeProjects;
  readonly terminals = new FakeTerminals();
  private context: FakeServiceContext;
  readonly forge: FakeForgeWire;
  constructor(context: FakeServiceContext) {
    this.context = context;
    this.projects = new FakeProjects(context, (id) => this.terminals.hasOwnedWork(id));
    this.forge = new FakeForgeWire(context);
  }
  readonly editors = [
    { id: "code", name: "Visual Studio Code", command: "code" },
    { id: "zed", name: "Zed", command: "zed" },
  ];
  /** The project's scripts as the daemon lists them from package.json, by workspace. */
  private scriptOverrides = new Map<string, readonly string[]>();
  setScripts(workspaceId: string, names: readonly string[]): void {
    this.scriptOverrides.set(workspaceId, names);
  }
  /** Per thread, the files `git status` reports, once set or once a commit changed them. */
  private gitFiles = new Map<string, readonly GitStatusFile[]>();
  /** What `git status` reports for a thread's checkout (`git.status`). */
  setGitStatus(threadId: string, files: readonly GitStatusFile[]): void {
    this.gitFiles.set(threadId, files);
  }
  private gitPatches = new Map<string, string>();
  setGitDiff(threadId: string, patch: string): void {
    this.gitPatches.set(threadId, patch);
  }
  /** Every file, sorted by path as git lists them (`git.status` pages the first 500). */
  gitStatus(threadId: string): readonly GitStatusFile[] {
    return (
      this.gitFiles.get(threadId) ??
      synthesizedStatus(this.context.thread(threadId)?.thread.details?.diff ?? emptyDiff)
    ).toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  scripts(workspaceId: string | undefined) {
    const names =
      (workspaceId === undefined ? undefined : this.scriptOverrides.get(workspaceId)) ??
      (workspaceId === "relay"
        ? ["dev:relay", "test", "soak", "typecheck"]
        : ["dev", "test", "build", "typecheck"]);
    return names.map((name) => ({
      id: `package.json:${name}`,
      name,
      source: "package.json" as const,
      command: `bun run ${name}`,
    }));
  }
  read(request: WorkspaceActionRequest) {
    const op = request.operation;
    if (op.op === "workspaces.list")
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: this.projects.list(op.after, op.limit),
      });
    if (op.op === "runs.list") {
      const all = Object.values(this.context.thread(op.threadId)?.runs ?? {}).filter(
        (run) => run.ordinal !== undefined,
      );
      const runs = all
        .filter((run) => (run.ordinal ?? 0) < op.before)
        .toSorted((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0));
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: {
          kind: "runs",
          total: all.length,
          runs: runs.slice(0, op.limit),
          ...(runs.length > op.limit ? { nextBefore: runs[op.limit - 1]?.ordinal } : {}),
        },
      });
    }
    if (op.op === "git.diff")
      return ServerMessage.parse({
        type: "workspace.result",
        requestId: request.requestId,
        result: {
          kind: "gitDiff",
          patch: this.gitPatches.get(op.threadId) ?? "",
          truncated: false,
        },
      });
    const result =
      op.op === "editors.list"
        ? { kind: "editors", editors: this.editors }
        : op.op === "scripts.list"
          ? {
              kind: "scripts",
              scripts: this.scripts(this.context.thread(op.threadId)?.thread.workspaceId),
            }
          : op.op === "branches.list"
            ? {
                kind: "branches",
                branches: ["main", "develop"],
                truncated: false,
                refs: fakeBranchRefs,
                defaultBranch: "main",
              }
            : op.op === "pr.status"
              ? { kind: "pr", status: this.forge.status(op.threadId) }
              : op.op === "git.status"
                ? {
                    kind: "gitStatus",
                    files: this.gitStatus(op.threadId).slice(0, gitStatusLimit),
                    truncated: this.gitStatus(op.threadId).length > gitStatusLimit,
                  }
                : op.op === "thread.details"
                  ? {
                      kind: "details",
                      details: this.context.thread(op.threadId)?.thread.details ?? {},
                    }
                  : { kind: "error", code: "unsupported" };
    return ServerMessage.parse({ type: "workspace.result", requestId: request.requestId, result });
  }
  command(
    payload: CommandPayload,
    commandId = "fixture",
  ): Omit<CommandResult, "commandId"> | undefined {
    const project = this.projects.command(payload);
    if (project) return project;
    const forge = this.forge.command(payload);
    if (forge) return forge;
    if (!("threadId" in payload) || !payload.threadId) return undefined;
    const thread = this.context.thread(payload.threadId)?.thread;
    if (
      ["workspace.editor.open", "workspace.script.run", "git.commit", "git.push"].includes(
        payload.type,
      ) &&
      !thread
    )
      return { ok: false, error: "thread_not_found" };
    if (payload.type === "thread.workspace.set") {
      const view = this.context.thread(payload.threadId);
      if (!view || view.thread.deletedAt !== undefined)
        return { ok: false, error: "thread_not_found" };
      if (
        !["new", "done", "failed"].includes(view.thread.status.state) ||
        this.terminals.hasOwnedWork(payload.threadId)
      )
        return { ok: false, error: "thread_tree_is_live" };
      const details = view.thread.details ?? {};
      if (!payload.allowUncommitted && (details.diff?.files ?? 0) > 0)
        return { ok: false, error: "git_dirty_worktree" };
      if (payload.branch && !["main", "develop"].includes(payload.branch))
        return { ok: false, error: "git_invalid_ref" };
      for (const state of ["preparing", "applied"] as const)
        this.context.update(payload.threadId, {
          type: "thread.client.updated",
          changes: {
            details: {
              ...details,
              mode: payload.mode,
              branch: payload.branch ?? details.branch ?? "main",
              worktree:
                payload.mode === "worktree"
                  ? `/fake/worktrees/${payload.threadId}`
                  : `/fake/${view.thread.workspaceId}`,
              workspaceChange: { commandId, state, at: this.context.now(), lossy: true },
            },
          },
        });
      return { ok: true, threadId: payload.threadId };
    }
    if (payload.type === "workspace.editor.open") {
      const editor = this.editors.find((entry) => entry.id === payload.editorId);
      return editor
        ? {
            ok: true,
            editor: { editor, path: thread?.details?.worktree ?? `/fake/${thread?.workspaceId}` },
          }
        : { ok: false, error: "editor_not_found" };
    }
    if (payload.type === "workspace.script.run") {
      const script = this.scripts(thread?.workspaceId).find(
        (entry) => entry.id === payload.scriptId,
      );
      if (!script) return { ok: false, error: "script_not_found" };
      const terminal = this.terminals.openNow({
        threadId: payload.threadId,
        name: script.name,
        cwd: thread?.details?.worktree ?? "/fake",
        cols: 80,
        rows: 24,
      });
      this.terminals.output(terminal.id, `${script.command}\r\n`);
      const printed = scriptOutput(script.name);
      if (printed.text) this.terminals.output(terminal.id, printed.text);
      if (printed.done) this.terminals.prompt(terminal.id);
      return { ok: true, terminalId: terminal.id };
    }
    if (payload.type === "git.commit") {
      if ((thread?.details?.head ?? null) !== payload.expectedHead)
        return { ok: false, error: "git_head_moved" };
      const commit = "a".repeat(40);
      // Only the paths named are committed; the rest stay uncommitted, as with git. A rename
      // named by one of its paths splits: the half not named stays (its old path a deletion,
      // its new one an addition).
      const named = payload.paths && new Set(payload.paths);
      const left = named
        ? this.gitStatus(payload.threadId).flatMap((file): GitStatusFile[] => {
            if (!file.from) return named.has(file.path) ? [] : [file];
            const added = named.has(file.path);
            const removed = named.has(file.from);
            if (added && removed) return [];
            if (!added && !removed) return [file];
            const { from, ...rest } = file;
            return added
              ? [{ path: from, status: "deleted", additions: 0, deletions: 0, binary: false }]
              : [{ ...rest, status: "added" }];
          })
        : [];
      this.gitFiles.set(payload.threadId, left);
      this.context.update(payload.threadId, {
        type: "thread.client.updated",
        changes: {
          details: {
            ...thread?.details,
            head: commit,
            ahead: (thread?.details?.ahead ?? 0) + 1,
            diff: {
              files: left.length,
              additions: left.reduce((sum, file) => sum + file.additions, 0),
              deletions: left.reduce((sum, file) => sum + file.deletions, 0),
            },
          },
        },
      });
      return { ok: true, commit };
    }
    if (payload.type === "git.push") {
      this.context.update(payload.threadId, {
        type: "thread.client.updated",
        changes: { details: { ...thread?.details, ahead: 0 } },
      });
      return { ok: true };
    }
    return undefined;
  }
  descriptor(id: string, threadId: ThreadId) {
    const terminal = this.terminals.list(threadId).find((entry) => entry.id === id);
    if (!terminal) throw new Error("terminal_not_found");
    return {
      id,
      threadId,
      name: terminal.name,
      pid: 1,
      exited: terminal.exitCode !== null,
      ...this.terminals.offsets(id),
    };
  }
}
