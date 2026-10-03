import {
  ServerMessage,
  type WorkspaceActionRequest,
  type CommandPayload,
  type CommandResult,
  type ThreadId,
} from "@ace/protocol";
import { FakeForgeWire } from "./forge-wire.ts";
import { FakeTerminals } from "./terminals.ts";
import type { FakeServiceContext } from "./service-context.ts";
export class FakeWorkspaceWire {
  readonly terminals = new FakeTerminals();
  private context: FakeServiceContext;
  private forge: FakeForgeWire;
  constructor(context: FakeServiceContext) {
    this.context = context;
    this.forge = new FakeForgeWire(context);
  }
  readonly editors = [
    { id: "code", name: "Visual Studio Code", command: "code" },
    { id: "zed", name: "Zed", command: "zed" },
  ];
  readonly scripts = [
    {
      id: "package.json:dev",
      name: "dev",
      source: "package.json" as const,
      command: "bun run dev",
    },
  ];
  read(request: WorkspaceActionRequest) {
    const op = request.operation;
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
    const result =
      op.op === "editors.list"
        ? { kind: "editors", editors: this.editors }
        : op.op === "scripts.list"
          ? { kind: "scripts", scripts: this.scripts }
          : op.op === "branches.list"
            ? { kind: "branches", branches: ["main", "develop"], truncated: false }
            : op.op === "pr.status"
              ? { kind: "pr", status: this.forge.status(op.threadId) }
              : op.op === "thread.details"
                ? {
                    kind: "details",
                    details: this.context.thread(op.threadId)?.thread.details ?? {},
                  }
                : {
                    kind: "workspaces",
                    workspaces: [
                      ...new Map(
                        this.context.threads().map((thread) => [
                          thread.workspaceId,
                          {
                            id: thread.workspaceId,
                            name: thread.details?.workspace?.name ?? thread.workspaceId,
                            path: thread.details?.workspace?.path ?? `/fake/${thread.workspaceId}`,
                          },
                        ]),
                      ).values(),
                    ]
                      .filter((workspace) => workspace.id > (op.after ?? ""))
                      .slice(0, op.limit),
                  };
    return ServerMessage.parse({ type: "workspace.result", requestId: request.requestId, result });
  }
  command(payload: CommandPayload): Omit<CommandResult, "commandId"> | undefined {
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
      const script = this.scripts.find((entry) => entry.id === payload.scriptId);
      if (!script) return { ok: false, error: "script_not_found" };
      const terminal = this.terminals.openNow({
        threadId: payload.threadId,
        name: script.name,
        cwd: thread?.details?.worktree ?? "/fake",
        cols: 80,
        rows: 24,
      });
      this.terminals.output(terminal.id, `$ ${script.command}\r\n`);
      return { ok: true, terminalId: terminal.id };
    }
    if (payload.type === "git.commit") {
      if ((thread?.details?.head ?? null) !== payload.expectedHead)
        return { ok: false, error: "head_changed" };
      const commit = "a".repeat(40);
      this.context.update(payload.threadId, {
        type: "thread.client.updated",
        changes: {
          details: {
            ...thread?.details,
            head: commit,
            ahead: (thread?.details?.ahead ?? 0) + 1,
            diff: { files: 0, additions: 0, deletions: 0 },
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
