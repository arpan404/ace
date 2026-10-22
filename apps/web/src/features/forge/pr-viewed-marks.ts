import { useMemo } from "react";
import type { ForgeFile } from "@ace/protocol";
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
 * Viewed marks for the displayed range: GitHub's own, which exist only for All commits at the head the review state was read at. `availability`
 * says why no file has a mark; `count` is undefined when nothing is known.
 */
export function usePrViewedMarks(context: PrDiffContext | undefined) {
  const review = usePrReview();
  const range = context?.files;
  const native =
    range && !range.commit && review?.state?.headSha === range.headSha
      ? (review.state.viewed ?? undefined)
      : undefined;
  const byPath = useMemo(
    () => new Map(native?.map((viewed) => [viewed.path, viewed.state])),
    [native],
  );
  const availability: "available" | "unavailable" | "all-commits-only" = native
    ? "available"
    : range?.commit && review?.state?.viewed
      ? "all-commits-only"
      : "unavailable";
  const markOf = (file: ForgeFile): PrViewedMark | undefined => {
    if (!context) return undefined;
    const state = byPath.get(file.path);
    if (state === undefined || !review) return undefined;
    return {
      checked: state === "VIEWED",
      changed: state === "DISMISSED",
      disabled: context.disabled || !review.ready || review.pending,
      change: (checked) =>
        review.run({
          kind: checked ? "file.view" : "file.unview",
          path: file.path,
          headSha: context.files.headSha,
        }),
    };
  };
  const count = native?.filter((viewed) => viewed.state === "VIEWED").length;
  return { markOf, count, availability };
}
