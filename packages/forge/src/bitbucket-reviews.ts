import { z } from "zod";
import { ForgePrReviewers } from "@ace/protocol/forge-people";
import { ForgeComment, ForgeReviewThread } from "@ace/protocol/forge";
import type { ForgeReviewAction, ForgeReviewDraft } from "@ace/protocol/forge-review";
import type { WriteDispatch } from "./write-dispatch.ts";
import { writesUnder, type HostApiWrite } from "./read-only-api.ts";
import { bitbucketRepoPath, bktWrite } from "./bkt-api.ts";
import { BitbucketPulls, type BitbucketOptions } from "./bitbucket-pulls.ts";
import { account, decode, name, pageFields, type Account, type Pull } from "./bitbucket-records.ts";
import { writeMarkerHash } from "./github-reviews.ts";
import { ForgeError } from "./errors.ts";
import { clipText } from "./host-text.ts";

/** Review writes in `repository`, on PR `number` when known (ADR 0118). */
export function bitbucketReviewWrites(
  repository: { owner: string; name: string },
  number?: number,
): readonly HostApiWrite[] {
  const pr = number === undefined ? "[1-9]\\d*" : String(z.number().int().positive().parse(number));
  return writesUnder(bitbucketRepoPath(repository), [
    { method: "POST", path: `/pullrequests/${pr}/comments` },
    { method: "POST", path: `/pullrequests/${pr}/approve` },
    { method: "DELETE", path: `/pullrequests/${pr}/approve` },
    { method: "POST", path: `/pullrequests/${pr}/request-changes` },
    { method: "DELETE", path: `/pullrequests/${pr}/request-changes` },
  ]);
}

const comment = z.looseObject({
  id: z.number().int().positive(),
  content: z.looseObject({ raw: z.string().nullable().optional() }).optional(),
  user: account.nullable().optional(),
  created_on: z.string(),
  updated_on: z.string().nullable().optional(),
  deleted: z.boolean().optional(),
  pending: z.boolean().optional(),
  parent: z.looseObject({ id: z.number().int().positive() }).nullable().optional(),
  inline: z
    .looseObject({
      path: z.string(),
      from: z.number().int().positive().nullable().optional(),
      to: z.number().int().positive().nullable().optional(),
    })
    .nullable()
    .optional(),
  resolution: z.looseObject({}).nullable().optional(),
});
type Comment = z.infer<typeof comment>;
const CommentPage = z.looseObject({ values: z.array(comment).max(100), ...pageFields });
const viewer = account.extend({ uuid: z.string().min(1) });

/**
 * A positive id for someone's review, from their Bitbucket uuid: Bitbucket approvals have no id
 * of their own, and dismissal must name whose review it withdraws.
 */
export function reviewId(uuid: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uuid.length; i++) hash = Math.imul(hash ^ uuid.charCodeAt(i), 0x01000193);
  return ((hash >>> 0) % 2_147_483_646) + 1;
}
/**
 * A hidden marker naming the operation a comment was written by, so an uncertain write can be
 * found again. A Markdown reference definition, which Bitbucket's renderer doesn't show.
 */
export function bitbucketWriteMarker(operationId: string): string {
  return `[//]: # (ace-write:${writeMarkerHash(operationId)})`;
}
/** Bitbucket pull request comments and approvals. Drafts and receipts belong to the daemon. */
export class BitbucketReviews {
  readonly #pulls: BitbucketPulls;
  readonly #options: BitbucketOptions;
  constructor(options: BitbucketOptions) {
    this.#options = options;
    this.#pulls = new BitbucketPulls(options);
  }
  #comments(number: number, signal: AbortSignal): Promise<Comment[]> {
    return this.#pulls.all(
      `${this.#pulls.root}/pullrequests/${number}/comments?pagelen=100`,
      CommentPage,
      2000,
      signal,
    );
  }
  async #viewer(signal: AbortSignal) {
    return decode(viewer, await this.#pulls.get("/2.0/user", signal));
  }
  /**
   * Comments, inline threads (a root inline comment and its replies) and each participant's
   * verdict, all read at one head. Deleted comments and others' pending drafts are left out.
   */
  async conversation(number: number, signal: AbortSignal) {
    const { p, head } = await this.#pulls.pinned(number, signal);
    const raw = await this.#comments(number, signal);
    const live = raw.filter((c) => !c.deleted && !c.pending);
    const byId = new Map(live.map((c) => [c.id, c]));
    const root = (c: Comment): Comment => {
      let current = c;
      for (let depth = 0; current.parent && depth < 100; depth++) {
        const parent = byId.get(current.parent.id);
        if (!parent) break;
        current = parent;
      }
      return current;
    };
    const mapped = new Map<number, z.infer<typeof ForgeComment>>();
    for (const c of live) {
      const inline = root(c).inline;
      mapped.set(
        c.id,
        decode(ForgeComment, {
          kind: inline ? "inline" : "issue",
          id: c.id,
          body: clipText(c.content?.raw ?? ""),
          author: name(c.user),
          createdAt: c.created_on,
          updatedAt: c.updated_on ?? c.created_on,
          file: inline ? clipText(inline.path) : null,
          line: inline ? (inline.to ?? inline.from ?? null) : null,
          replyTo: c.parent && byId.has(c.parent.id) ? c.parent.id : null,
        }),
      );
    }
    const threads: z.infer<typeof ForgeReviewThread>[] = [];
    for (const c of live) {
      if (!c.inline || root(c) !== c) continue;
      const members = live.filter((m) => root(m) === c).toSorted((a, b) => a.id - b.id);
      threads.push(
        decode(ForgeReviewThread, {
          id: String(c.id),
          resolved: c.resolution != null,
          // Bitbucket doesn't say whether a comment's lines changed since it was written.
          outdated: false,
          file: clipText(c.inline.path),
          line: c.inline.to ?? c.inline.from ?? null,
          side: c.inline.to ? "RIGHT" : "LEFT",
          comments: members.flatMap((m) => mapped.get(m.id) ?? []),
        }),
      );
    }
    const comments = [...mapped.values()];
    for (const r of verdicts(p))
      comments.push(
        decode(ForgeComment, {
          kind: "review",
          id: r.id,
          body: "",
          author: r.login,
          createdAt: r.submittedAt ?? undefined,
          updatedAt: r.submittedAt ?? "",
          file: null,
          line: null,
          replyTo: null,
          reviewState: r.state,
        }),
      );
    await this.#pulls.still(number, head, signal);
    if (comments.length > 2000 || threads.length > 2000) throw new ForgeError("limit");
    return { comments, reviewThreads: threads, raw: { comments: raw } };
  }
  async reviewers(number: number, signal: AbortSignal) {
    const p = await this.#pulls.pull(number, signal);
    const given = verdicts(p);
    return decode(ForgePrReviewers, {
      author: name(p.author) || null,
      canRequest: false,
      canDismiss: false,
      suggested: [],
      requested: (p.participants ?? [])
        .filter((x) => x.role === "REVIEWER" && x.user && !x.approved && !x.state)
        .flatMap((x) => (name(x.user) ? [{ kind: "user", login: name(x.user) }] : [])),
      reviews: given,
    });
  }
  /** What the review journal needs: the viewer, the head and what they may do. */
  async host(number: number, signal: AbortSignal) {
    const [{ p, head }, me] = await Promise.all([
      this.#pulls.pinned(number, signal),
      this.#viewer(signal),
    ]);
    return {
      viewer: name(me),
      pr: {
        headRefOid: head,
        state: p.state === "OPEN" ? "OPEN" : p.state,
        // Anyone who can read a Bitbucket pull request may comment; the host refuses the rest.
        viewerCanComment: true,
        viewerDidAuthor: p.author?.uuid === me.uuid,
      },
      threads: [],
    };
  }
  async viewedNow(_number: number, _signal: AbortSignal): Promise<never> {
    throw new ForgeError("unsupported");
  }
  async decorations(_number: number, _signal: AbortSignal) {
    return { reactions: null, hidden: null, hideable: null };
  }
  async moveDrafts(
    _number: number,
    _head: string,
    _drafts: readonly ForgeReviewDraft[],
    _signal: AbortSignal,
  ): Promise<never> {
    throw new ForgeError("unsupported");
  }
  async write(
    number: number,
    action: ForgeReviewAction,
    drafts: readonly ForgeReviewDraft[],
    operation: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch?: WriteDispatch,
  ): Promise<void> {
    const send = async (path: string, method: "POST" | "DELETE", body?: object) => {
      signal.throwIfAborted();
      if (!allowed()) throw new ForgeError("forbidden");
      await bktWrite(
        this.#options.runner,
        this.#options.login,
        `${this.#pulls.root}/pullrequests/${number}/${path}`,
        method,
        body,
        signal,
        dispatch,
      );
    };
    const text = (body: string) => `${body}\n\n${bitbucketWriteMarker(operation)}`;
    if (action.kind === "conversation") {
      await this.#open(number, undefined, signal);
      return send("comments", "POST", { content: { raw: text(action.body) } });
    }
    if (action.kind === "line.comment") {
      // One line on one side; Bitbucket's multi-line ranges aren't sent.
      if (action.anchor.startLine !== undefined || action.anchor.commit !== action.headSha)
        throw new ForgeError("unsupported");
      await this.#open(number, action.headSha, signal);
      const side = action.anchor.side === "RIGHT" ? "to" : "from";
      return send("comments", "POST", {
        content: { raw: text(action.body) },
        inline: { path: action.anchor.path, [side]: action.anchor.line },
      });
    }
    if (action.kind === "reply") {
      if (action.pendingReview) throw new ForgeError("unsupported");
      const parent = (await this.#comments(number, signal)).find(
        (c) => c.id === action.commentId && !c.deleted && !c.pending,
      );
      if (!parent) throw new ForgeError("not_found");
      return send("comments", "POST", {
        content: { raw: text(action.body) },
        parent: { id: action.commentId },
      });
    }
    if (action.kind === "submit") {
      // Bitbucket verdicts carry no body or batched drafts. Refuse rather than drop text.
      if (
        action.event === "COMMENT" ||
        action.body.trim() ||
        drafts.length ||
        action.draftIds.length
      )
        throw new ForgeError("unsupported");
      const { p } = await this.#open(number, action.headSha, signal);
      const me = await this.#viewer(signal);
      if (p.author?.uuid === me.uuid) throw new ForgeError("forbidden");
      // Bitbucket's approve takes no commit; the head was checked just before.
      return send(action.event === "APPROVE" ? "approve" : "request-changes", "POST");
    }
    if (action.kind === "review.dismiss") {
      const p = await this.#pulls.pull(number, signal);
      const me = await this.#viewer(signal);
      // Only one's own verdict can be withdrawn.
      if (reviewId(me.uuid) !== action.reviewId) throw new ForgeError("forbidden");
      const mine = (p.participants ?? []).find((x) => x.user?.uuid === me.uuid);
      if (mine?.approved || mine?.state === "approved") return send("approve", "DELETE");
      if (mine?.state === "changes_requested") return send("request-changes", "DELETE");
      throw new ForgeError("not_found");
    }
    throw new ForgeError("unsupported");
  }
  /** The open pull request, at `head` when the write names one. */
  async #open(number: number, head: string | undefined, signal: AbortSignal) {
    const pinned = await this.#pulls.pinned(number, signal);
    if (pinned.p.state !== "OPEN") throw new ForgeError("forbidden");
    if (head !== undefined && pinned.head !== head.toLowerCase())
      throw new ForgeError("head_moved");
    return pinned;
  }
  /** Whether an uncertain write landed, read back from the pull request. */
  async reconcile(
    number: number,
    action: ForgeReviewAction,
    operation: string,
    signal: AbortSignal,
    _drafts: readonly ForgeReviewDraft[] = [],
  ): Promise<boolean> {
    const me = await this.#viewer(signal);
    if (action.kind === "submit" || action.kind === "review.dismiss") {
      const p = await this.#pulls.pull(number, signal);
      const mine = (p.participants ?? []).find((x) => x.user?.uuid === me.uuid);
      const approved = mine?.approved === true || mine?.state === "approved";
      const changes = mine?.state === "changes_requested";
      if (action.kind === "review.dismiss") return !approved && !changes;
      return action.event === "APPROVE" ? approved : action.event === "REQUEST_CHANGES" && changes;
    }
    if (action.kind !== "conversation" && action.kind !== "line.comment" && action.kind !== "reply")
      return false;
    const marker = bitbucketWriteMarker(operation);
    return (await this.#comments(number, signal)).some(
      (c) =>
        !c.deleted &&
        c.user?.uuid === me.uuid &&
        (c.content?.raw ?? "").includes(marker) &&
        (action.kind !== "reply" || c.parent?.id === action.commentId) &&
        (action.kind !== "line.comment" ||
          (c.inline?.path === action.anchor.path &&
            (action.anchor.side === "RIGHT" ? c.inline.to : c.inline.from) === action.anchor.line)),
    );
  }
}

/** Each participant's standing verdict: approved, or changes requested. */
function verdicts(p: Pull) {
  return (p.participants ?? []).flatMap((x) => {
    const who: Account | null | undefined = x.user;
    if (!who?.uuid || !name(who)) return [];
    const state =
      x.approved === true || x.state === "approved"
        ? ("APPROVED" as const)
        : x.state === "changes_requested"
          ? ("CHANGES_REQUESTED" as const)
          : undefined;
    if (!state) return [];
    return [
      { id: reviewId(who.uuid), login: name(who), state, submittedAt: x.participated_on ?? null },
    ];
  });
}
