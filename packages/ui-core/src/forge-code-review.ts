import type { ForgeReviewAnchor, ForgeReviewState } from "@ace/protocol";

/*
 * The rules a pull request's Code view follows wherever it is drawn (web and phone): which
 * files carry GitHub's Viewed marks for the range shown, and where a comment on picked lines
 * anchors.
 */

/** Why no file has a Viewed mark, or that they have one. */
export type ViewedAvailability = "available" | "unavailable" | "all-commits-only";

/** A file's Viewed mark: `changed` once it was pushed to after it was viewed. */
export interface ViewedState {
  checked: boolean;
  changed: boolean;
}

/**
 * GitHub's Viewed marks for the range shown. They exist only for All commits at the head the
 * review state was read at: one commit, a span of commits or another head shows none.
 */
export function viewedMarks(
  review: Pick<ForgeReviewState, "headSha" | "viewed"> | null | undefined,
  range: { headSha: string; commit?: string | undefined } | undefined,
): {
  availability: ViewedAvailability;
  /** How many files are viewed; undefined when nothing is known. */
  count: number | undefined;
  of(path: string): ViewedState | undefined;
} {
  const native =
    range && !range.commit && review?.headSha === range.headSha
      ? (review.viewed ?? undefined)
      : undefined;
  const byPath = new Map(native?.map((viewed) => [viewed.path, viewed.state]));
  return {
    availability: native
      ? "available"
      : range?.commit && review?.viewed
        ? "all-commits-only"
        : "unavailable",
    count: native?.filter((viewed) => viewed.state === "VIEWED").length,
    of(path) {
      const state = byPath.get(path);
      return state === undefined
        ? undefined
        : { checked: state === "VIEWED", changed: state === "DISMISSED" };
    },
  };
}

/** Lines picked on one side of a file's diff, `start` to `end` inclusive. */
export interface PickedLines {
  side: "old" | "new";
  start: number;
  end: number;
}

/** The review anchor for `range` of `path` at `headSha`: one line, or a span ending at `end`. */
export function lineRangeAnchor(
  path: string,
  range: PickedLines,
  headSha: string,
): ForgeReviewAnchor {
  const side = range.side === "old" ? "LEFT" : "RIGHT";
  return {
    commit: headSha,
    path,
    line: range.end,
    side,
    ...(range.start < range.end ? { startLine: range.start, startSide: side } : {}),
  };
}

/** What the Code tab can't show in full, as short sentences for its one warning. */
export function codeCaveats(facts: {
  viewed: ViewedAvailability;
  truncated: boolean;
  commitsTruncated: boolean;
}): string[] {
  const notes: string[] = [];
  if (facts.viewed === "unavailable")
    notes.push("GitHub's viewed state is unavailable, so no file shows as viewed.");
  if (facts.viewed === "all-commits-only")
    notes.push("Viewed marks apply to All commits, not to a single commit.");
  if (facts.truncated) notes.push("Some changed files couldn't be listed.");
  if (facts.commitsTruncated) notes.push("Only the newest 10,000 commits are listed.");
  return notes;
}

/** "Changes since your last review": the commits after the head of the viewer's latest review. */
export interface SinceLastReview {
  /** The head the review was made at; the range starts after it. */
  since: string;
  /** The pull request's head now; the range ends there. */
  commit: string;
  /** How many commits came after it. */
  count: number;
}

/**
 * The range from the signed-in reviewer's latest review to the head, when there is one to show:
 * they reviewed, the head moved since, and the reviewed head is still one of the PR's commits (a
 * force-push can leave it out, and then there is no honest range to name).
 */
export function sinceLastReview(
  reviewers: {
    viewer?: string | null | undefined;
    reviews: readonly { login: string; commitSha?: string | null | undefined }[];
  },
  commits: readonly { sha: string }[],
  headSha: string,
): SinceLastReview | undefined {
  const viewer = reviewers.viewer?.toLowerCase();
  if (!viewer) return undefined;
  const reviewed = reviewers.reviews.find((review) => review.login.toLowerCase() === viewer);
  const since = reviewed?.commitSha?.toLowerCase();
  if (!since || since === headSha.toLowerCase()) return undefined;
  const at = commits.findIndex((commit) => commit.sha.toLowerCase() === since);
  const head = commits.findIndex((commit) => commit.sha.toLowerCase() === headSha.toLowerCase());
  if (at < 0 || head <= at) return undefined;
  return { since: commits[at]?.sha ?? since, commit: headSha, count: head - at };
}
