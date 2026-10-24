import { z } from "zod";
import type { ForgeHiddenReason, ForgeReviewAction } from "@ace/protocol/forge-review";
import type { WriteDispatch } from "./write-dispatch.ts";
import { ForgeError } from "./errors.ts";
import { hiddenReason } from "./github-reactions.ts";
import { decode, type ReviewIo } from "./review-io.ts";

type VisibilityAction = Extract<ForgeReviewAction, { kind: "comment.hide" | "comment.unhide" }>;
type Mutation = (
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  dispatch: WriteDispatch,
) => Promise<void>;
const text = z.string().max(65_536);
/** The classifier names GitHub's minimizeComment mutation takes. */
const classifiers: Record<ForgeHiddenReason, string> = {
  "off-topic": "OFF_TOPIC",
  outdated: "OUTDATED",
  resolved: "RESOLVED",
  duplicate: "DUPLICATE",
  spam: "SPAM",
};
const Visibility = z.object({
  data: z.object({
    node: z
      .object({
        isMinimized: z.boolean(),
        minimizedReason: text.nullable(),
        viewerCanMinimize: z.boolean(),
      })
      .nullable(),
  }),
});
const visibilityQuery = `query CommentVisibility($id:ID!){ node(id:$id){ ... on Minimizable { isMinimized minimizedReason viewerCanMinimize } } }`;

/** Hides (minimizes) and unhides one of the PR's own comments by its GraphQL node id. */
export class GitHubCommentVisibility {
  readonly #io: ReviewIo;
  readonly #mutation: Mutation;
  constructor(io: ReviewIo, mutation: Mutation) {
    this.#io = io;
    this.#mutation = mutation;
  }
  /** The comment's node id and visibility; only a comment of this PR is ever looked up. */
  async #read(number: number, action: VisibilityAction, signal: AbortSignal) {
    const comment = await this.#io.comment(number, action.source, action.commentId, signal);
    if (!comment) throw new ForgeError("not_found", undefined, false);
    if (!comment.node_id) throw new ForgeError("invalid_data");
    const response = await this.#io.request("graphql", signal, {
      query: visibilityQuery,
      variables: { id: comment.node_id },
    });
    const node = decode(Visibility, response.body).data.node;
    if (!node) throw new ForgeError("not_found", undefined, false);
    return { id: comment.node_id, ...node };
  }
  async write(
    number: number,
    action: VisibilityAction,
    operationId: string,
    signal: AbortSignal,
    allowed: () => boolean,
    dispatch: WriteDispatch,
  ): Promise<void> {
    const comment = await this.#read(number, action, signal);
    if (!comment.viewerCanMinimize) throw new ForgeError("forbidden");
    if (signal.aborted || !allowed()) throw new ForgeError("cancelled");
    if (action.kind === "comment.hide")
      await this.#mutation(
        "minimizeComment",
        {
          subjectId: comment.id,
          classifier: classifiers[action.reason],
          clientMutationId: operationId,
        },
        signal,
        dispatch,
      );
    else
      await this.#mutation(
        "unminimizeComment",
        { subjectId: comment.id, clientMutationId: operationId },
        signal,
        dispatch,
      );
  }
  /** Hidden for the asked reason, or shown again, as GitHub reports the comment now. */
  async reconcile(number: number, action: VisibilityAction, signal: AbortSignal) {
    const comment = await this.#read(number, action, signal);
    return action.kind === "comment.hide"
      ? comment.isMinimized && hiddenReason(comment.minimizedReason) === action.reason
      : !comment.isMinimized;
  }
}
