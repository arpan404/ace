import { useState, type ReactNode } from "react";
import type { ForgeFile, ForgeReviewAnchor } from "@ace/protocol";
import type { LineRange } from "@/features/panels/index.ts";
import type { PrDiffContext } from "./pr-extensions.ts";
import { usePrReview } from "./pr-review-context.tsx";
import { PrInlineDraft } from "./pr-review-forms.tsx";
import { PrViewedCheckbox, usePrViewedFile } from "./pr-review-diff.tsx";

/** Native hosted review keeps its command journal while the shared renderer owns display. */
export function PrFileReview(props: {
  file: ForgeFile;
  context: PrDiffContext;
  children(native: {
    onComment: ((range: LineRange) => void) | undefined;
    viewed: boolean | undefined;
    actions: ReactNode;
  }): ReactNode;
}) {
  const review = usePrReview();
  const [anchor, setAnchor] = useState<ForgeReviewAnchor>();
  const range = props.context.files;
  const viewed = usePrViewedFile({ path: props.file.path, headSha: range.headSha });
  const current = !range.commit && review?.state?.headSha === range.headSha;
  const canComment =
    current &&
    review?.state?.canComment &&
    review.ready &&
    !review.pending &&
    !props.context.disabled;
  return (
    <>
      {props.children({
        onComment: canComment
          ? (line) => {
              const side = line.side === "old" ? "LEFT" : "RIGHT";
              setAnchor({
                commit: range.headSha,
                path: props.file.path,
                line: line.end,
                side,
                ...(line.start !== line.end ? { startLine: line.start, startSide: side } : {}),
              });
            }
          : undefined,
        viewed: current && viewed.file ? viewed.file.state === "VIEWED" : undefined,
        actions:
          !range.commit && review ? (
            <PrViewedCheckbox
              path={props.file.path}
              headSha={range.headSha}
              disabled={props.context.disabled}
            />
          ) : null,
      })}
      {current && anchor && (
        <PrInlineDraft
          key={JSON.stringify(anchor)}
          prKey={JSON.stringify(range.ref)}
          anchor={anchor}
          onClose={() => setAnchor(undefined)}
        />
      )}
    </>
  );
}
