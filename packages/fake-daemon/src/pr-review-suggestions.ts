import type { ForgeReviewAction } from "@ace/protocol";
import { suggestionOf } from "@ace/forge/suggestions";
import type { PullRequestFixture } from "./catalog/pull-request-details.ts";

type Apply = Extract<ForgeReviewAction, { kind: "suggestions.apply" }>;
/** Its lines left the diff: GitHub keeps the comment but gives it no line. */
const outdated = <T extends { line: number | null }>(each: T): T =>
  Object.assign({}, each, { line: null });

/**
 * `suggestions.apply` on a catalog PR, as GitHub commits it: only at the head the person saw,
 * only suggestions still on the diff, all in one new commit. The committed lines changed, so
 * their conversations read as outdated afterwards, as GitHub shows them. Answers the PR after
 * the commit, or the refusal's code.
 */
export function commitSuggestions(fixture: PullRequestFixture, action: Apply) {
  const { status } = fixture.detail;
  if (status.state !== "open" && status.state !== "draft") return "forge_conflict";
  if (status.headSha !== action.headSha) return "forge_head_moved";
  const ids = new Set(action.commentIds);
  const threads = status.reviewThreads.filter((thread) =>
    thread.comments.some((comment) => ids.has(comment.id)),
  );
  const comments = threads.flatMap((thread) => thread.comments).filter((c) => ids.has(c.id));
  if (comments.length !== ids.size) return "forge_not_found";
  if (comments.some((comment) => !suggestionOf(comment.body))) return "forge_validation_failed";
  if (threads.some((thread) => thread.outdated || thread.line === null)) return "forge_conflict";
  // The new commit's id: the old head turned once, so it never names an earlier commit.
  const headSha = `5${status.headSha.slice(0, -1)}`;
  const moved = new Set(threads.map((thread) => thread.id));
  return {
    ...fixture,
    detail: {
      ...fixture.detail,
      status: {
        ...status,
        headSha,
        comments: status.comments.map((c) => (ids.has(c.id) ? outdated(c) : c)),
        reviewThreads: status.reviewThreads.map((thread) =>
          moved.has(thread.id)
            ? Object.assign(outdated(thread), {
                outdated: true,
                comments: thread.comments.map((c) => (ids.has(c.id) ? outdated(c) : c)),
              })
            : thread,
        ),
      },
    },
    ...(fixture.mergeState ? { mergeState: { ...fixture.mergeState, headSha } } : {}),
    lifecycle: { ...fixture.lifecycle, snapshot: { ...fixture.lifecycle.snapshot, headSha } },
    review: { ...fixture.review, headSha },
  } satisfies PullRequestFixture;
}
