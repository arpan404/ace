import { useMemo } from "react";
import type { ForgeFile } from "@ace/protocol";
import { viewedMarks } from "@ace/ui-core";
import type { PrDiffContext } from "./pr-extensions.ts";
import { usePrReview } from "./pr-review-context.tsx";

/** A file's Viewed mark at the displayed range. `changed`: pushed to since it was viewed. */
export interface PrViewedMark {
  checked: boolean;
  changed: boolean;
  disabled: boolean;
  change(checked: boolean): Promise<unknown>;
}

/**
 * Viewed marks for the displayed range, by the shared rule (`viewedMarks`): GitHub's own, which
 * exist only for All commits at the head the review state was read at. `availability` says why
 * no file has a mark; `count` is undefined when nothing is known.
 */
export function usePrViewedMarks(context: PrDiffContext | undefined) {
  const review = usePrReview();
  const range = context?.files;
  const state = review?.state;
  const marks = useMemo(
    () =>
      viewedMarks(
        state,
        range
          ? { headSha: range.headSha, ...(range.commit ? { commit: range.commit } : {}) }
          : undefined,
      ),
    [state, range],
  );
  const markOf = (file: ForgeFile): PrViewedMark | undefined => {
    if (!context || !review) return undefined;
    const mark = marks.of(file.path);
    if (!mark) return undefined;
    return {
      ...mark,
      disabled: context.disabled || !review.ready || review.pending,
      change: (checked) =>
        review.run({
          kind: checked ? "file.view" : "file.unview",
          path: file.path,
          headSha: context.files.headSha,
        }),
    };
  };
  return { markOf, count: marks.count, availability: marks.availability };
}
