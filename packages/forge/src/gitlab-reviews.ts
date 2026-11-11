import type { ForgeRepository } from "@ace/protocol/forge";
import { ForgeReviewAction, type ForgeReviewDraft } from "@ace/protocol/forge-review";
import { GitLabApi, gitLabProjectPath } from "./gitlab-api.ts";
import { GitLabConversation } from "./gitlab-conversation.ts";
import {
  GitLabApprovals,
  GitLabUser,
  GitLabUsers,
  GitLabObject,
  GitLabDiscussion,
  GitLabNote,
} from "./gitlab-conversation-records.ts";
import { hostedDiffLines, validHostedAnchor } from "./review-anchor.ts";
import { Mr, DiffPage, headOf, requireSha, must } from "./gitlab-records.ts";
import { ForgeError } from "./errors.ts";
import { ReadBudget } from "./read-budget.ts";
import { WriteDispatch } from "./write-dispatch.ts";
import { reviewWriteMarker } from "./github-reviews.ts";
import type { CommandRunner } from "./command.ts";
import { writesUnder, type HostApiWrite } from "./read-only-api.ts";

/** Exact admission, scoped to this selected project and MR. No issue or project mutations. */
export function gitLabReviewWrites(
  repository: ForgeRepository,
  number: number,
): readonly HostApiWrite[] {
  return writesUnder(`${gitLabProjectPath(repository)}/merge_requests/${number}`, [
    { method: "POST", path: "/notes" },
    { method: "POST", path: "/discussions" },
    { method: "POST", path: "/discussions/[a-fA-F0-9]+/notes" },
    { method: "PUT", path: "/discussions/[a-fA-F0-9]+" },
    { method: "POST", path: "/(approve|unapprove)" },
    { method: "PUT", path: "" },
  ]);
}

/** GitLab implements the journal's review contract; unsupported GitHub actions fail closed. */
export class GitLabReviews {
  readonly #api: GitLabApi;
  readonly #conversation: GitLabConversation;
  constructor(options: { repository: ForgeRepository; runner: CommandRunner }) {
    if (options.repository.forge !== "gitlab") throw new ForgeError("unsupported");
    this.#api = new GitLabApi(options);
    this.#conversation = new GitLabConversation(this.#api);
  }
  async host(number: number, signal: AbortSignal) {
    const mr = await this.#conversation.mr(number, signal);
    const viewer = must(
      GitLabUser.safeParse((await this.#api.get("user", signal, new ReadBudget())).body),
    );
    const discussions = await this.#conversation.discussions(number, signal);
    return {
      viewer: viewer.username,
      pending: null,
      pr: {
        state: mr.state === "opened" ? "OPEN" : mr.state.toUpperCase(),
        headRefOid: requireSha(headOf(mr)),
        viewerCanComment: mr.discussion_locked !== true,
        viewerDidAuthor: mr.author?.username === viewer.username,
      },
      threads: discussions
        .filter((d) => d.notes.some((n) => n.resolvable))
        .map((d) => ({
          id: d.id,
          isResolved: d.notes.filter((n) => n.resolvable).every((n) => n.resolved === true),
          viewerCanResolve: true,
          viewerCanUnresolve: true,
        })),
    };
  }
  async viewedNow(
    _number: number,
    _signal: AbortSignal,
  ): Promise<{ headSha: string; files: { path: string; state: string }[] }> {
    throw new ForgeError("unsupported");
  }
  async decorations(_number: number, _signal: AbortSignal) {
    return { reactions: null, hidden: null, hideable: null };
  }
  async moveDrafts(
    _number: number,
    _headSha: string,
    _drafts: readonly ForgeReviewDraft[],
    _signal: AbortSignal,
  ): Promise<ForgeReviewDraft[]> {
    throw new ForgeError("unsupported");
  }
  async #write(
    endpoint: string,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ) {
    signal.throwIfAborted();
    if (!allowed()) throw new ForgeError("cancelled", undefined, false);
    try {
      const response = await this.#api.write(
        endpoint,
        method,
        body,
        signal,
        new ReadBudget(),
        dispatch,
      );
      // Approval replies vary by GitLab edition, so they only need to be an object.
      const schema = endpoint.endsWith("/notes")
        ? GitLabNote
        : endpoint.includes("/discussions")
          ? GitLabDiscussion
          : /\/(approve|unapprove)$/.test(endpoint)
            ? GitLabObject
            : Mr;
      if (!schema.safeParse(response.body).success) throw new ForgeError("invalid_data");
    } catch (error) {
      throw dispatch.failure(error);
    }
  }
  async write(
    number: number,
    input: ForgeReviewAction,
    drafts: ForgeReviewDraft[],
    operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch = new WriteDispatch(),
  ) {
    const action = ForgeReviewAction.parse(input);
    const root = this.#conversation.path(number);
    const marker = reviewWriteMarker(operationId);
    if (action.kind === "conversation")
      return this.#write(
        `${root}/notes`,
        "POST",
        { body: `${action.body}\n\n${marker}` },
        signal,
        allowed,
        dispatch,
      );
    if (action.kind === "reply") {
      if (action.pendingReview) throw new ForgeError("unsupported");
      const discussion = (await this.#conversation.discussions(number, signal)).find((d) =>
        d.notes.some((n) => n.id === action.commentId && !n.system),
      );
      if (!discussion) throw new ForgeError("not_found");
      return this.#write(
        `${root}/discussions/${this.#discussionId(discussion.id)}/notes`,
        "POST",
        { body: `${action.body}\n\n${marker}` },
        signal,
        allowed,
        dispatch,
      );
    }
    if (action.kind === "thread.resolve" || action.kind === "thread.unresolve") {
      const discussion = (await this.#conversation.discussions(number, signal)).find(
        (d) => d.id === action.threadId,
      );
      if (!discussion?.notes.some((n) => n.resolvable)) throw new ForgeError("not_found");
      return this.#write(
        `${root}/discussions/${this.#discussionId(action.threadId)}`,
        "PUT",
        { resolved: action.kind === "thread.resolve" },
        signal,
        allowed,
        dispatch,
      );
    }
    if (action.kind === "submit") {
      // GitLab approvals have no review body or batched draft submission. Refuse rather than drop text.
      if (
        action.event !== "APPROVE" ||
        action.body.trim() ||
        drafts.length ||
        action.draftIds.length
      )
        throw new ForgeError("unsupported");
      const mr = await this.#conversation.mr(number, signal);
      if (headOf(mr).toLowerCase() !== action.headSha.toLowerCase())
        throw new ForgeError("head_moved");
      return this.#write(
        `${root}/approve`,
        "POST",
        { sha: action.headSha },
        signal,
        allowed,
        dispatch,
      );
    }
    if (action.kind === "review.dismiss") {
      // A GitLab approval id is its approver's id. Only one's own approval can be withdrawn.
      const viewer = must(
        GitLabUser.safeParse((await this.#api.get("user", signal, new ReadBudget())).body),
      );
      if (viewer.id !== action.reviewId) throw new ForgeError("forbidden");
      return this.#write(`${root}/unapprove`, "POST", {}, signal, allowed, dispatch);
    }
    if (action.kind === "reviewers.request" || action.kind === "reviewers.remove") {
      if (action.teams?.length) throw new ForgeError("unsupported");
      const mr = await this.#conversation.mr(number, signal);
      const current = must(GitLabUsers.safeParse(mr.reviewers ?? []));
      const ids = new Set(current.map((u) => u.id));
      for (const username of action.reviewers) {
        const users = must(
          GitLabUsers.safeParse(
            (
              await this.#api.get(
                `users?username=${encodeURIComponent(username)}`,
                signal,
                new ReadBudget(),
              )
            ).body,
          ),
        );
        const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
        if (!user) throw new ForgeError("not_found");
        if (action.kind === "reviewers.request") ids.add(user.id);
        else ids.delete(user.id);
      }
      return this.#write(root, "PUT", { reviewer_ids: [...ids] }, signal, allowed, dispatch);
    }
    if (action.kind === "line.comment") {
      if (
        action.anchor.commit.toLowerCase() !== action.headSha.toLowerCase() ||
        action.anchor.startLine !== undefined
      )
        throw new ForgeError("unsupported");
      const budget = new ReadBudget();
      const mr = await this.#conversation.mr(number, signal, budget);
      if (headOf(mr).toLowerCase() !== action.headSha.toLowerCase())
        throw new ForgeError("head_moved");
      const refs = mr.diff_refs;
      const base = requireSha(refs?.base_sha ?? "");
      const start = requireSha(refs?.start_sha ?? "");
      const head = requireSha(refs?.head_sha ?? "");
      // Resolve renamed paths from the pinned diff, rather than invent an old path.
      const files = await this.#api.records(`${root}/diffs`, DiffPage.element, signal, budget);
      const file = files.find(
        (f) => (action.anchor.side === "RIGHT" ? f.new_path : f.old_path) === action.anchor.path,
      );
      if (!file) throw new ForgeError("not_found");
      if (!validHostedAnchor(file.diff, action.anchor)) throw new ForgeError("conflict");
      const coordinate = hostedDiffLines(file.diff).find(
        (line) => (action.anchor.side === "RIGHT" ? line.right : line.left) === action.anchor.line,
      );
      if (!coordinate) throw new ForgeError("conflict");
      const latest = must(Mr.safeParse((await this.#api.get(root, signal, budget)).body));
      if (
        latest.diff_refs?.head_sha !== head ||
        latest.diff_refs?.base_sha !== base ||
        latest.diff_refs?.start_sha !== start
      )
        throw new ForgeError("head_moved");
      return this.#write(
        `${root}/discussions`,
        "POST",
        {
          body: `${action.body}\n\n${marker}`,
          position: {
            position_type: "text",
            base_sha: base,
            start_sha: start,
            head_sha: head,
            old_path: file.old_path,
            new_path: file.new_path,
            ...(coordinate.right !== undefined ? { new_line: coordinate.right } : {}),
            ...(coordinate.left !== undefined ? { old_line: coordinate.left } : {}),
          },
        },
        signal,
        allowed,
        dispatch,
      );
    }
    throw new ForgeError("unsupported");
  }
  #discussionId(id: string) {
    if (!/^[a-fA-F0-9]+$/.test(id)) throw new ForgeError("invalid_data");
    return id;
  }
  async reconcile(
    number: number,
    action: ForgeReviewAction,
    operationId: string,
    signal: AbortSignal,
    _drafts: readonly ForgeReviewDraft[] = [],
  ): Promise<boolean> {
    const root = this.#conversation.path(number);
    const viewer = must(
      GitLabUser.safeParse((await this.#api.get("user", signal, new ReadBudget())).body),
    );
    if (action.kind === "submit" || action.kind === "review.dismiss") {
      const approvals = must(
        GitLabApprovals.safeParse(
          (await this.#api.get(`${root}/approvals`, signal, new ReadBudget())).body,
        ),
      );
      if (action.kind === "review.dismiss")
        return (
          action.reviewId === viewer.id &&
          !approvals.approved_by.some((a) => a.user.id === viewer.id)
        );
      const mr = await this.#conversation.mr(number, signal);
      return (
        action.event === "APPROVE" &&
        headOf(mr).toLowerCase() === action.headSha.toLowerCase() &&
        approvals.approved_by.some((a) => a.user.id === viewer.id)
      );
    }
    if (action.kind === "reviewers.request" || action.kind === "reviewers.remove") {
      const mr = await this.#conversation.mr(number, signal);
      const users = must(GitLabUsers.safeParse(mr.reviewers ?? []));
      return action.reviewers.every(
        (name) =>
          users.some((u) => u.username.toLowerCase() === name.toLowerCase()) ===
          (action.kind === "reviewers.request"),
      );
    }
    const discussions = await this.#conversation.discussions(number, signal);
    if (action.kind === "thread.resolve" || action.kind === "thread.unresolve") {
      const notes = discussions
        .find((d) => d.id === action.threadId)
        ?.notes.filter((n) => n.resolvable);
      return (
        !!notes?.length && notes.every((n) => n.resolved === (action.kind === "thread.resolve"))
      );
    }
    const marker = reviewWriteMarker(operationId);
    if (action.kind !== "conversation" && action.kind !== "reply" && action.kind !== "line.comment")
      return false;
    return discussions.some((d) => {
      if (action.kind === "reply" && !d.notes.some((n) => n.id === action.commentId)) return false;
      return d.notes.some(
        (n) =>
          !n.system &&
          n.author?.id === viewer.id &&
          n.body.includes(marker) &&
          (action.kind !== "line.comment" ||
            (n.position?.head_sha.toLowerCase() === action.headSha.toLowerCase() &&
              (action.anchor.side === "RIGHT"
                ? n.position.new_path === action.anchor.path &&
                  n.position.new_line === action.anchor.line
                : n.position.old_path === action.anchor.path &&
                  n.position.old_line === action.anchor.line))),
      );
    });
  }
}
