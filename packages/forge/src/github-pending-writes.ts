import { z } from "zod";
import type { ForgeReviewAction, ForgeReviewDraft } from "@ace/protocol/forge-review";
import type { WriteDispatch } from "./write-dispatch.ts";
import { ForgeError } from "./errors.ts";
import { decode, type ReviewIo } from "./review-io.ts";
import { fileCommentBody } from "./review-draft-move.ts";

type DraftFile = Extract<ForgeReviewAction, { kind: "draft.file" }>;
type Reply = Extract<ForgeReviewAction, { kind: "reply" }>;
type HostPr = { state: string; headRefOid: string; viewerCanComment: boolean };
type Mutation = (
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  dispatch: WriteDispatch,
) => Promise<void>;
const text = z.string().max(65_536);
const Inline = z.looseObject({
  id: z.number().int().positive(),
  body: text,
  path: text.optional(),
  user: z.looseObject({ login: text }).nullable(),
});
const PendingComments = z.object({
  data: z.object({
    node: z
      .object({
        state: text.optional(),
        comments: z.object({ nodes: z.array(z.object({ body: text })).max(100) }).optional(),
      })
      .nullable(),
  }),
});

/**
 * Writes that keep a review's text when GitHub's review can't carry it as it is: an outdated
 * draft posted on its file, and a reply added to the viewer's review pending on GitHub.
 */
export class GitHubPendingWrites {
  readonly #io: ReviewIo;
  readonly #mutation: Mutation;
  constructor(io: ReviewIo, mutation: Mutation) {
    this.#io = io;
    this.#mutation = mutation;
  }
  /** One file-level comment quoting the draft's earlier code; it never joins a review. */
  async fileComment(
    number: number,
    action: DraftFile,
    drafts: readonly ForgeReviewDraft[],
    host: { pr: HostPr },
    marker: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<void> {
    const draft = drafts[0];
    if (drafts.length !== 1 || draft?.id !== action.id || !draft.outdated)
      throw new ForgeError("conflict");
    if (host.pr.state !== "OPEN" || host.pr.headRefOid !== action.headSha)
      throw new ForgeError("conflict");
    if (!host.pr.viewerCanComment) throw new ForgeError("forbidden");
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    const response = await this.#io.request(
      `${this.#io.root}/pulls/${number}/comments`,
      signal,
      {
        commit_id: action.headSha,
        path: draft.anchor.path,
        subject_type: "file",
        body: `${fileCommentBody(draft)}\n\n${marker}`,
      },
      "POST",
      dispatch,
    );
    decode(Inline, response.body);
  }
  async reconcileFileComment(
    number: number,
    drafts: readonly ForgeReviewDraft[],
    viewer: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const path = drafts[0]?.anchor.path;
    const comments = await this.#io.records(
      `${this.#io.root}/pulls/${number}/comments?per_page=100`,
      Inline,
      signal,
    );
    return comments.some(
      (c) => c.user?.login === viewer && c.body.includes(marker) && c.path === path,
    );
  }
  /** The reply joins the viewer's pending review on GitHub, unsent until they submit it. */
  async pendingReply(
    action: Reply & { pendingReview: NonNullable<Reply["pendingReview"]> },
    pending: string | undefined,
    marker: string,
    operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<void> {
    // Only the review GitHub holds pending for the viewer now; a submitted one takes no reply.
    if (pending !== action.pendingReview.reviewId) throw new ForgeError("conflict");
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    await this.#mutation(
      "addPullRequestReviewThreadReply",
      {
        pullRequestReviewId: action.pendingReview.reviewId,
        pullRequestReviewThreadId: action.pendingReview.threadId,
        body: `${action.body}\n\n${marker}`,
        clientMutationId: operationId,
      },
      signal,
      dispatch,
    );
  }
  async reconcilePendingReply(
    action: Reply & { pendingReview: NonNullable<Reply["pendingReview"]> },
    marker: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const response = await this.#io.request("graphql", signal, {
      query: `query($id:ID!){ node(id:$id){ ... on PullRequestReview { state comments(last:100){ nodes { body } } } } }`,
      variables: { id: action.pendingReview.reviewId },
    });
    const review = decode(PendingComments, response.body).data.node;
    return !!review?.comments?.nodes.some((c) => c.body.includes(marker));
  }
}
