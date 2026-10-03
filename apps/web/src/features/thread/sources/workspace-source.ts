// A thread's checkout through the daemon's workspace service (ADR 0057): reads go through
// `workspace.request`, and running a script, opening an editor, committing, pushing and opening
// a PR are durable commands with receipts. The fake daemon serves the same messages.
import type { ClientApi } from "@ace/client";
import {
  ThreadId,
  type CommandPayload,
  type CommandResult,
  type ForgePrStatus,
  type ForgeRepository,
  type ThreadDetails,
  type WorkspaceActionRequest,
  type WorkspaceActionResult,
  type WorkspaceScript,
} from "@ace/protocol";

export interface ThreadRef {
  id: string;
  workspaceId: string;
  title: string;
  /** The New thread composer: nothing exists on the daemon yet. */
  draft?: boolean | undefined;
}

export type Script = WorkspaceScript;
export type EditorLaunch = NonNullable<CommandResult["editor"]>;

export interface PrInput {
  repository: ForgeRepository;
  branch: string;
  base: string;
  title: string;
  summary: string;
  draft: boolean;
}

/** What the daemon's codes mean to a person. Unknown codes fall back to a generic sentence. */
const messages: Record<string, string> = {
  forbidden: "This device may not change the checkout.",
  workspace_preparing: "The thread's worktree is still being prepared.",
  workspace_root_changed: "The thread's worktree moved. Try again.",
  thread_not_found: "The thread is gone.",
  script_not_found: "That script is no longer in the project.",
  script_shell_unsupported: "Scripts can't run on this daemon's platform yet.",
  editor_not_found: "That editor is no longer installed.",
  head_changed: "The branch moved since you looked. Review the changes and try again.",
  repository_mismatch: "The checkout's remote changed. Refresh and try again.",
  terminal_limit: "Too many terminals are open. Close one and try again.",
};

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(messages[code] ?? "The daemon couldn't do that.");
    this.name = "WorkspaceError";
    this.code = code;
  }
}

type Operation = WorkspaceActionRequest["operation"];
type Result = WorkspaceActionResult["result"];

export interface WorkspaceSource {
  /** Reads the checkout again; the daemon also publishes it to the thread's live details. */
  details(thread: ThreadRef, signal?: AbortSignal): Promise<ThreadDetails>;
  /** The linked PR as the forge reports it now, or null when none is linked. */
  prStatus(thread: ThreadRef, signal?: AbortSignal): Promise<ForgePrStatus | null>;
  scripts(thread: ThreadRef, signal?: AbortSignal): Promise<readonly Script[]>;
  /** Starts the script in a new terminal in the thread's checkout; returns that terminal. */
  runScript(thread: ThreadRef, script: Script): Promise<string>;
  /** The validated launch for opening the checkout in an installed editor. */
  openIn(thread: ThreadRef, editorId: string): Promise<EditorLaunch>;
  /** Commits every change; `expectedHead` guards against a branch that moved meanwhile. */
  commit(thread: ThreadRef, message: string, expectedHead: string | null): Promise<string>;
  push(thread: ThreadRef): Promise<void>;
  /** Opens a pull request for the branch; returns its number. */
  createPr(thread: ThreadRef, input: PrInput): Promise<number>;
}

const is = <K extends Result["kind"]>(
  result: Result,
  kind: K,
): result is Extract<Result, { kind: K }> => result.kind === kind;

const id = (thread: ThreadRef) => ThreadId.parse(thread.id);

export function daemonWorkspaceSource(client: ClientApi): WorkspaceSource {
  const read = async <K extends Result["kind"]>(
    operation: Operation,
    kind: K,
    signal?: AbortSignal,
  ): Promise<Extract<Result, { kind: K }>> => {
    const reply = await client.request(
      { type: "workspace.request", operation },
      signal ? { signal } : {},
    );
    const result = reply.result;
    if (result.kind === "error") throw new WorkspaceError(result.code);
    if (!is(result, kind)) throw new WorkspaceError("unexpected");
    return result;
  };
  const run = async (payload: CommandPayload): Promise<CommandResult> => {
    const result = await client.command(payload);
    if (!result.ok) throw new WorkspaceError(result.error ?? "failed");
    return result;
  };
  return {
    details: async (thread, signal) =>
      (await read({ op: "thread.details", threadId: id(thread) }, "details", signal)).details,
    prStatus: async (thread, signal) =>
      (await read({ op: "pr.status", threadId: id(thread) }, "pr", signal)).status,
    scripts: async (thread, signal) =>
      (await read({ op: "scripts.list", threadId: id(thread) }, "scripts", signal)).scripts,
    async runScript(thread, script) {
      const result = await run({
        type: "workspace.script.run",
        threadId: id(thread),
        scriptId: script.id,
      });
      if (!result.terminalId) throw new WorkspaceError("unexpected");
      return result.terminalId;
    },
    async openIn(thread, editorId) {
      const result = await run({ type: "workspace.editor.open", threadId: id(thread), editorId });
      if (!result.editor) throw new WorkspaceError("unexpected");
      return result.editor;
    },
    async commit(thread, message, expectedHead) {
      const result = await run({ type: "git.commit", threadId: id(thread), message, expectedHead });
      return result.commit ?? "";
    },
    async push(thread) {
      await run({ type: "git.push", threadId: id(thread), remote: "origin" });
    },
    async createPr(thread, input) {
      const result = await run({
        type: "forge.pr.create",
        threadId: thread.id,
        repository: input.repository,
        input: {
          branch: input.branch,
          base: input.base,
          title: input.title,
          summary: input.summary,
          // The forge fills these from the fields above.
          template: { title: "{{title}}", body: "{{summary}}" },
          draft: input.draft,
        },
      });
      if (!result.pr) throw new WorkspaceError("unexpected");
      return result.pr.number;
    },
  };
}
