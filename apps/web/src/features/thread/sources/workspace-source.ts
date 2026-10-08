// A thread's checkout through the daemon's workspace service (ADR 0057): reads go through
// `workspace.request`, and running a script, opening an editor, committing, pushing and opening
// a PR are durable commands with receipts. The fake daemon serves the same messages.
import type { ClientApi } from "@ace/client";
import { actionErrorText, type MergeMethod } from "@ace/ui-core";
import {
  ThreadId,
  type CommandPayload,
  type CommandResult,
  type ForgePrRef,
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

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(actionErrorText(code));
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
  /**
   * Opens a pull request for the branch, or links the one the forge already has for it (the
   * daemon never opens a second); returns its status as the forge reports it.
   */
  createPr(thread: ThreadRef, input: PrInput): Promise<ForgePrStatus>;
  /** Links an existing pull request to the thread. */
  linkPr(thread: ThreadRef, pr: ForgePrRef): Promise<ForgePrStatus>;
  /** Removes the local PR link without contacting the forge. */
  unlinkPr(thread: ThreadRef): Promise<void>;
  /** Reads the linked PR from the forge now (checks, mergeability, review threads). */
  refreshPr(thread: ThreadRef, pr: ForgePrRef): Promise<ForgePrStatus>;
  /**
   * Merges the PR at `headSha` (refused if it moved), or with `auto`, has the forge merge it
   * once its checks pass.
   */
  mergePr(
    thread: ThreadRef,
    pr: ForgePrRef,
    change: { headSha: string; method: MergeMethod; auto: boolean },
  ): Promise<ForgePrStatus>;
  requestReview(
    thread: ThreadRef,
    pr: ForgePrRef,
    reviewers: readonly string[],
  ): Promise<ForgePrStatus>;
  /** Replies in the review thread of an inline PR comment. */
  replyToComment(
    thread: ThreadRef,
    pr: ForgePrRef,
    commentId: number,
    body: string,
  ): Promise<ForgePrStatus>;
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

/** Every forge action answers with the PR's fresh status. */
function status(result: CommandResult): ForgePrStatus {
  if (!result.prStatus) throw new WorkspaceError("forge_invalid_data");
  return result.prStatus;
}

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
      return status(
        await run({
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
        }),
      );
    },
    linkPr: async (thread, pr) =>
      status(await run({ type: "forge.pr.link", link: { threadId: thread.id, pr } })),
    unlinkPr: async (thread) => {
      await run({ type: "forge.pr.unlink", threadId: thread.id });
    },
    refreshPr: async (thread, pr) =>
      status(await run({ type: "forge.pr.status", link: { threadId: thread.id, pr } })),
    mergePr: async (thread, pr, change) =>
      status(
        await run({
          type: change.auto ? "forge.pr.auto-merge" : "forge.pr.merge",
          link: { threadId: thread.id, pr },
          headSha: change.headSha,
          method: change.method,
        }),
      ),
    requestReview: async (thread, pr, reviewers) =>
      status(
        await run({
          type: "forge.review.request",
          link: { threadId: thread.id, pr },
          reviewers: [...reviewers],
        }),
      ),
    replyToComment: async (thread, pr, commentId, body) =>
      status(
        await run({
          type: "forge.comment.reply",
          link: { threadId: thread.id, pr },
          commentId,
          body,
        }),
      ),
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
