import { PlusIcon, TagIcon } from "@phosphor-icons/react";
import { LabelPill } from "@/components/forge-marks.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrReviewers } from "./pr-reviewers.tsx";
import { reviewerRows, type ReviewerRow } from "./pr-reviewers-model.ts";
import { usePrReviewers } from "./pr-reviewers-query.ts";

/**
 * Reviewers and labels on one line: an avatar stack ringed by each reviewer's latest verdict,
 * then the labels as chips at the right end.
 */
export function PrPeople(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  onRequestReview: (() => void) | undefined;
  onEdit: (() => void) | undefined;
}) {
  const { detail, disabled } = props.context;
  // Kept current by the PR view (`usePrActions`); this line only reads.
  const reviewers = usePrReviewers(props.context.workspaceId, detail);
  // Until GitHub's reviewer list arrives, the PR's own list of who is asked stands in.
  const rows: ReviewerRow[] = reviewers.data
    ? reviewerRows(reviewers.data)
    : detail.reviewers.map((name) => ({
        key: `user:${name.toLowerCase()}`,
        kind: "user",
        name,
        label: name,
        avatarUrl: detail.reviewerAvatars?.[name],
        requested: true,
        canRerequest: false,
        canRemove: false,
        canDismiss: false,
      }));
  const reviewerPicker =
    props.extensions?.reviewers?.(props.context) ??
    (props.onRequestReview && (
      <IconButton
        icon={PlusIcon}
        label="Request review"
        size="sm"
        disabled={disabled}
        onClick={props.onRequestReview}
      />
    ));
  const labelPicker =
    props.extensions?.labels?.(props.context) ??
    (props.onEdit && (
      <IconButton
        icon={TagIcon}
        label="Edit labels"
        size="sm"
        disabled={disabled}
        onClick={props.onEdit}
      />
    ));
  // Nobody asked and no labels: nothing to show. Request review and Edit live in the ⋯ menu.
  if (!rows.length && !detail.labels.length) return null;
  return (
    <div
      id="pr-reviewers"
      className="flex min-h-8 scroll-mt-2 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <div role="group" aria-label="Reviewers" className="flex items-center gap-1.5">
        {rows.length ? (
          <PrReviewers
            rows={rows}
            value={reviewers.data}
            disabled={disabled}
            onDismissed={() => void reviewers.refetch()}
            onRequestReview={props.onRequestReview}
          />
        ) : (
          <span className="text-xs text-muted-foreground">No reviewers yet</span>
        )}
        {reviewerPicker}
      </div>
      {(detail.labels.length > 0 || labelPicker) && (
        <div
          role="group"
          aria-label="Labels"
          // The picker's glyph, not its box, ends on the column's edge.
          className={cn(
            "ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1",
            labelPicker && "-mr-1",
          )}
        >
          {detail.labels.map((label) => (
            <LabelPill key={label} name={label} color={detail.labelColors?.[label]} />
          ))}
          {labelPicker}
        </div>
      )}
    </div>
  );
}
