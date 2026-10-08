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
  type GitStatusFile,
  type ProviderKind,
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
  /** A draft's chosen provider and account, which scope its slash commands. */
  provider?: ProviderKind | undefined;
  instanceId?: string | undefined;
}

export type Script = WorkspaceScript;
export type ChangedFile = GitStatusFile;
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
  git_head_moved: "The branch moved since you looked. Refresh the changes and try again.",
  git_hook_failed:
    "A git hook rejected the change. Fix the hook's reported problem in a terminal and try again.",
  git_auth_failed: "Git authentication failed. Sign in to your remote in a terminal and try again.",
  git_conflicts: "Git found conflicts. Resolve them in the checkout and try again.",
  git_remote_unreachable:
    "Git couldn't reach the remote. Check the remote URL and your connection, then retry.",
  git_quarantined:
    "Git cleanup is still pending. Wait for cleanup or restart the daemon before retrying.",
  forge_not_found:
    "The pull request or repository wasn't found. Check its number and your repository access.",
  forge_forbidden:
    "GitHub denied access. Check your repository permissions and run gh auth login if needed.",
  forge_rate_limit: "GitHub's request limit was reached. Wait before refreshing or trying again.",
  forge_cli: "GitHub CLI failed. Check that gh is installed and run gh auth login, then retry.",
  forge_auth: "GitHub authentication failed. Run gh auth login in a terminal and retry.",
  forge_unsupported: "This forge isn't supported yet. Open the pull request on its website.",
  forge_conflict:
    "GitHub rejected the change because the PR changed or can't merge. Refresh and resolve conflicts or failing checks.",
  forge_invalid_data: "GitHub returned unreadable data. Update gh and refresh the pull request.",
  forge_limit: "The pull request is too large to read here. Open it on GitHub.",
  forge_cancelled: "The GitHub request was cancelled. Try again.",
  action_outcome_uncertain:
    "The daemon lost the action's result. Check the checkout or GitHub before trying again.",
  action_busy: "Too many actions are running. Wait for one to finish and retry.",
  pr_link_changed: "The linked pull request changed. Refresh before trying again.",
  forge_recovery_unavailable: "This daemon can't find an existing PR. Update the daemon and retry.",
  workspace_change_in_progress: "The checkout is moving. Wait for it to finish, then retry.",
  repository_mismatch: "The checkout's remote changed. Refresh and try again.",
  terminal_limit: "Too many terminals are open. Close one and try again.",
  thread_tree_is_live: "Wait for the agents to stop: the checkout can't move under live work.",
  terminal_owned: "Close the thread's terminals first: the checkout can't move under them.",
  git_dirty_worktree:
    "Commit or discard the uncommitted changes, or carry them to the selected branch.",
  git_invalid_ref: "That branch doesn't exist in the project.",
  engine_unavailable: "This daemon can't move a thread's checkout.",
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
  /** The files a commit would take, exactly as `git status` reports them (first 500). */
  gitStatus(
    thread: ThreadRef,
    signal?: AbortSignal,
  ): Promise<{ files: readonly ChangedFile[]; truncated: boolean }>;
  /**
   * Commits `paths` (every change when absent); `expectedHead` guards against a branch that
   * moved meanwhile.
   */
  commit(
    thread: ThreadRef,
    message: string,
    expectedHead: string | null,
    paths?: readonly string[],
  ): Promise<string>;
  push(thread: ThreadRef): Promise<void>;
  /** Opens a pull request for the branch; returns its number. */
  createPr(thread: ThreadRef, input: PrInput): Promise<number>;
  /**
   * Moves the thread's checkout: into a worktree of its own, or onto another branch. The daemon
   * refuses while agents or terminals work in it. Uncommitted changes require explicit carry-over.
   */
  setCheckout(thread: ThreadRef, change: CheckoutChange): Promise<void>;
}

export interface CheckoutChange {
  mode: "local" | "worktree";
  branch?: string | undefined;
  allowUncommitted?: boolean | undefined;
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
    async gitStatus(thread, signal) {
      const { files, truncated } = await read(
        { op: "git.status", threadId: id(thread) },
        "gitStatus",
        signal,
      );
      return { files, truncated };
    },
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
    async commit(thread, message, expectedHead, paths) {
      const result = await run({
        type: "git.commit",
        threadId: id(thread),
        message,
        expectedHead,
        ...(paths ? { paths: [...paths] } : {}),
      });
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
    async setCheckout(thread, change) {
      await run({
        type: "thread.workspace.set",
        threadId: id(thread),
        mode: change.mode,
        ...(change.branch ? { branch: change.branch } : {}),
        allowUncommitted: change.allowUncommitted ?? false,
      });
    },
  };
}
