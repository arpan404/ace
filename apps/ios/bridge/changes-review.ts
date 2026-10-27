import type { ClientApi } from "@ace/client";
import type { ReviewReply, ReviewSession, ThreadId, WorkspaceId } from "@ace/protocol";
import {
  applySuggestion,
  discardDraft,
  displayedSelection,
  isOpen,
  isPending,
  readReplies,
  refreshDrafts,
  reply,
  resolveDraft,
  saveDraft,
  sendDrafts,
  setReviewStatus,
  type DiffRows,
  type ReviewDraft,
} from "@ace/ui-core/review";
import type { PatchSink, Preview } from "./agents.ts";
import type { ChangesKept } from "./changes-kept.ts";

/*
 * Local diff review in the Changes sheet (ADR 0038), by the web's rules (`@ace/ui-core/review`):
 * a selection becomes a draft checked against the lines the bridge holds, drafts go to the
 * agent, replies, resolving, suggestions and approval go through the daemon, and a refresh
 * brings in comments made on other devices. Drafts live in the phone's kept value.
 *
 * Comments go on the Uncommitted scope only: a turn's diff is built from the agent's edits, so
 * its line numbers aren't the checkout's and a comment there couldn't be anchored.
 */

/** Why the sheet's scope takes no comments, in words. */
export const turnScopeReason = "Comments go on Uncommitted: a turn's lines can't be anchored.";

/** Drafts one `changes.review` patch lists, newest first. */
const shownDrafts = 200;

export interface ReviewDeps {
  owner: Pick<ClientApi, "command">;
  kept: ChangesKept;
  sink: PatchSink;
  preview: Preview;
  threadId: string;
  epoch: number;
  thread: () => { id: ThreadId; workspaceId: WorkspaceId } | undefined;
  now: () => number;
  /** A fresh id for each review comment command. */
  id: () => string;
  /** The sheet shows the checkout's uncommitted changes, the only scope comments go on. */
  workingTree: () => boolean;
  /** The rows of `path` in the sheet's scope, diffed if it isn't open. */
  diffOf: (path: string) => DiffRows | undefined;
  /** A suggestion changed the checkout. */
  applied: () => void;
}

export interface DraftInput {
  key?: string | undefined;
  path: string;
  side: "old" | "new";
  start: number;
  end: number;
  text: string;
  suggestion?: string | undefined;
}

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Something went wrong: try again.";

export class SheetReview {
  #deps: ReviewDeps;
  #session: ReviewSession | null = null;
  #refreshing = false;
  #error = "";
  #stop: () => void;
  #closed = false;

  constructor(deps: ReviewDeps) {
    this.#deps = deps;
    this.#stop = deps.kept.subscribe(() => this.emit());
    this.emit();
    // Waits for the kept drafts when they read, but never for a read that keeps failing.
    void deps.kept.tried().then(() => this.refresh());
  }

  /** Drafts of this thread, newest first. */
  drafts(): ReviewDraft[] {
    return this.#deps.kept
      .get()
      .filter((draft) => draft.threadId === this.#deps.threadId)
      .toSorted((a, b) => b.createdAt - a.createdAt);
  }

  /** Save a comment on lines of the diff shown; the refusal in words, or undefined. */
  /** Whether the shown scope takes comments, and why not. */
  allowed(): { allowed: boolean; reason: string } {
    return this.#deps.workingTree()
      ? { allowed: true, reason: "" }
      : { allowed: false, reason: turnScopeReason };
  }

  draft(input: DraftInput): string | undefined {
    if (!this.#deps.workingTree()) return turnScopeReason;
    if (input.end < input.start || input.end - input.start >= 100)
      return "Comment on fewer than 100 lines.";
    const editing = input.key
      ? this.#deps.kept.get().find((draft) => draft.key === input.key)
      : undefined;
    if (input.key && (!editing || !isPending(editing)))
      return "Only an unsent comment can be edited.";
    const file = this.#deps.diffOf(input.path);
    const range = { side: input.side, start: input.start, end: input.end };
    const fingerprint = file && displayedSelection(file, range);
    if (!fingerprint) return "Those lines aren't in this diff any more: select them again.";
    saveDraft(this.#deps.kept, {
      ...(editing ? { key: editing.key } : {}),
      threadId: this.#deps.threadId,
      file: input.path,
      side: input.side,
      line: input.start,
      ...(input.end === input.start ? {} : { end: input.end }),
      text: input.text,
      ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion }),
      fingerprint,
      createdAt: editing?.createdAt ?? this.#deps.now(),
    });
    return undefined;
  }

  discard(key: string): void {
    const draft = this.#deps.kept.get().find((candidate) => candidate.key === key);
    if (draft && (isPending(draft) || draft.state === "resolved"))
      discardDraft(this.#deps.kept, key);
  }

  /** Send the named drafts, or every pending one of this thread. */
  async send(keys: readonly string[] | undefined): Promise<void> {
    const thread = this.#deps.thread();
    if (!thread) return;
    const picked =
      keys ??
      this.drafts()
        .filter(isPending)
        .map((draft) => draft.key);
    await sendDrafts(this.#deps.owner, this.#deps.kept, thread, picked, this.#deps.id);
  }

  resolve(key: string, resolved: boolean): Promise<void> {
    return resolveDraft(this.#deps.owner, this.#deps.kept, key, resolved);
  }

  async apply(key: string): Promise<void> {
    const thread = this.#deps.thread();
    if (!thread) return;
    await applySuggestion(this.#deps.owner, this.#deps.kept, thread, key, this.#deps.id);
    if (this.#deps.kept.get().find((draft) => draft.key === key)?.applied) this.#deps.applied();
  }

  /** Reply under a sent comment, then show its replies. The refusal in words, or undefined. */
  async reply(key: string, text: string): Promise<string | undefined> {
    const draft = this.#deps.kept.get().find((candidate) => candidate.key === key);
    if (!draft) return "That comment is gone.";
    try {
      await reply(this.#deps.owner, draft, text);
    } catch (error) {
      return message(error);
    }
    await this.replies(key);
    return undefined;
  }

  /** Read a comment's replies into `changes:replies`. */
  async replies(key: string): Promise<void> {
    const draft = this.#deps.kept.get().find((candidate) => candidate.key === key);
    const put = (state: "loading" | "ready" | "error", replies: ReviewReply[], why = "") =>
      this.#deps.sink.put("changes:replies", () =>
        this.#closed
          ? undefined
          : {
              type: "changes.replies",
              threadId: this.#deps.threadId,
              epoch: this.#deps.epoch,
              key,
              state,
              message: why,
              replies: replies.map((each) => ({
                id: each.id,
                text: this.#deps.preview(each.text, 4096),
              })),
            },
      );
    if (!draft?.sessionId || !draft.commentId)
      return put("ready", [], "Send the comment first: replies go under sent comments.");
    put("loading", []);
    try {
      put("ready", await readReplies(this.#deps.owner, draft.sessionId, draft.commentId));
    } catch (error) {
      put("error", [], message(error));
    }
  }

  /** Approve the thread's newest review or ask for changes. The refusal in words, or undefined. */
  async status(status: "approved" | "changes-requested"): Promise<string | undefined> {
    const thread = this.#deps.thread();
    if (!thread) return "The thread isn't loaded yet.";
    try {
      this.#session =
        (await setReviewStatus(this.#deps.owner, thread, this.#session, status)) ?? null;
      this.emit();
      return undefined;
    } catch (error) {
      return message(error);
    }
  }

  /** Read the daemon's sessions and comments for this thread, including other devices'. */
  async refresh(): Promise<void> {
    if (this.#refreshing || this.#closed) return;
    this.#refreshing = true;
    this.emit();
    try {
      this.#session = await refreshDrafts(this.#deps.owner, this.#deps.kept, this.#deps.threadId);
      this.#error = "";
    } catch (error) {
      this.#error = message(error);
    }
    this.#refreshing = false;
    this.emit();
  }

  emit(): void {
    if (this.#closed) return;
    const { sink, preview, threadId, epoch } = this.#deps;
    sink.put("changes:review", () => {
      if (this.#closed) return undefined;
      const drafts = this.drafts();
      return {
        type: "changes.review",
        threadId,
        epoch,
        session: this.#session && { id: this.#session.id, status: this.#session.status },
        refreshing: this.#refreshing,
        message: this.#error,
        storage: this.#deps.kept.trouble,
        pending: drafts.filter(isPending).length,
        open: drafts.filter(isOpen).length,
        resolved: drafts.filter((draft) => draft.state === "resolved").length,
        hidden: Math.max(0, drafts.length - shownDrafts),
        drafts: drafts.slice(0, shownDrafts).map((draft) => ({
          key: draft.key,
          path: preview(draft.file, 1024),
          side: draft.side,
          start: draft.line,
          end: draft.end ?? draft.line,
          text: preview(draft.text, 4096),
          suggestion: draft.suggestion === undefined ? null : preview(draft.suggestion, 8192),
          state: draft.state,
          error: draft.error === undefined ? null : preview(draft.error, 512),
          anchor: draft.anchor ?? null,
          applied: draft.applied ?? false,
          sent: draft.commentId !== undefined,
          createdAt: draft.createdAt,
        })),
      };
    });
  }

  close(): void {
    this.#closed = true;
    this.#stop();
    this.#deps.sink.clear("changes:review");
    this.#deps.sink.clear("changes:replies");
  }
}
