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
