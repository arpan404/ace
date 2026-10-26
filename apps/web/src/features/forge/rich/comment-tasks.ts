import { authoredReviewComment } from "@ace/forge/review-comment-body";
import type { ForgeComment } from "@ace/protocol";
import { usePrReview } from "../pr-review-context.tsx";
import { useTaskSave } from "./use-task-save.ts";

/**
 * How a ticked task box in a PR comment is saved: the comment edit the viewer's own comments
 * already have, guarded by the body it was read with. Undefined when the viewer can't edit it
 * (someone else's comment, a review summary) or a write is in flight.
 */
export function useCommentTasks(
  comment: ForgeComment,
): ((next: string) => Promise<boolean>) | undefined {
  const review = usePrReview();
  const editable =
    !!review?.state &&
    review.ready &&
    !review.pending &&
    comment.author === review.state.viewer &&
    comment.kind !== "review";
  const source = comment.kind;
  return useTaskSave(
    editable && review && source !== "review"
      ? (next) =>
          review.run({
            kind: "comment.edit",
            source,
            commentId: comment.id,
            expectedBody: comment.body,
            body: authoredReviewComment(next),
          })
      : undefined,
    `${comment.id}:${comment.body}`,
  );
}
