import type { ForgeReviewDraft, ForgeReviewState } from "@ace/protocol";
import { draftsToMove, fileCommentBody, moveDraft, movedDraft } from "@ace/forge/review-draft-move";
import { comparison } from "./catalog/moving-head.ts";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";

/*
 * Pending drafts after the head moved, as the daemon handles them: moved with their lines to
 * the new head when nothing since changed them, else kept where they were, outdated, until
 * the person posts them on their file.
 */

/**
 * The drafts after `drafts.move` at `headSha`: each one written on an earlier commit tried
 * against GitHub's comparison of that commit with the head. Refused off the current head.
 */
export function moveDrafts(
  fixture: PullRequestFixture,
  headSha: string,
): ForgeReviewDraft[] | "forge_conflict" {
  const { review } = fixture;
  if (headSha !== review.headSha) return "forge_conflict";
  const hosted = fixture.files.map((file) => ({
    path: file.path,
    patch: file.patch ?? undefined,
  }));
  const moving = new Set(draftsToMove(review.drafts, headSha));
  return review.drafts.map((draft) =>
    moving.has(draft)
      ? movedDraft(
          draft,
          moveDraft(draft, headSha, comparison(fixture, draft.anchor.commit), hosted),
          headSha,
        )
      : draft,
  );
}

/**
 * The outdated draft `draft.file` posts, with the body it posts with, and the drafts left.
 * Only an outdated draft posts on its file, and only against the head it was tried on.
 */
export function draftOnFile(
  review: ForgeReviewState,
  id: string,
  headSha: string,
):
  | { path: string; body: string; drafts: ForgeReviewDraft[] }
  | "forge_conflict"
  | "forge_not_found" {
  const draft = review.drafts.find((each) => each.id === id);
  if (!draft) return "forge_not_found";
  if (headSha !== review.headSha || draft.outdated?.headSha !== headSha) return "forge_conflict";
  return {
    path: draft.anchor.path,
    body: fileCommentBody(draft),
    drafts: review.drafts.filter((each) => each.id !== id),
  };
}
