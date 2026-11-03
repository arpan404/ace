import { useMemo } from "react";
import type { ForgeFile } from "@ace/protocol";
import { viewedMarks } from "@ace/ui-core";
import type { PrDiffContext } from "./pr-extensions.ts";
import { usePrReview } from "./pr-review-context.tsx";

/**
 * A file's Viewed mark at the displayed range. `changed`: pushed to since it was viewed.
 * `saving`: set here and not yet confirmed; `failed`: GitHub refused the last change.
 */
export interface PrViewedMark {
  checked: boolean;
  changed: boolean;
  disabled: boolean;
  saving: boolean;
  failed: string | undefined;
  change(checked: boolean): void;
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
    const local = review.viewed.changes.get(file.path);
    return {
      checked: local ? local.checked : mark.checked,
      changed: !local && mark.changed,
      // Changes wait their turn behind other writes; only a closed connection holds them.
      disabled: !review.ready,
      saving: !!local,
      failed: review.viewed.failed.get(file.path),
      change: (checked) => review.viewed.set(file.path, checked, context.files.headSha),
    };
  };
  // The count follows what each mark shows, changes on their way included.
  const count =
    marks.count === undefined
      ? undefined
      : marks.count +
        [...(review?.viewed.changes ?? [])].reduce((sum, [path, change]) => {
          const was = marks.of(path)?.checked;
          return was === undefined || was === change.checked ? sum : sum + (change.checked ? 1 : -1);
        }, 0);
  return { markOf, count, availability: marks.availability };
}
