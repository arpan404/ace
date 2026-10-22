import type { ReviewOutcome } from "@ace/ui-core";
import { PlusIcon, TagIcon } from "@phosphor-icons/react";
import { LabelPill } from "@/components/forge-marks.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { PrAvatar } from "./pr-presentation.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { reviewerOutcomes, reviewOutcomeLabels } from "./pr-summary-model.ts";

/** The verdict's colour, drawn as a 2px band around the avatar. */
const band: Record<ReviewOutcome, string> = {
  approved: "bg-status-done",
  changes: "bg-status-failed",
  commented: "bg-border-strong",
  dismissed: "bg-border opacity-60",
};

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
  const outcomes = reviewerOutcomes(detail.status.comments);
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
  if (!detail.reviewers.length && !detail.labels.length) return null;
  return (
    <div
      id="pr-reviewers"
      className="flex min-h-8 scroll-mt-2 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <div role="group" aria-label="Reviewers" className="flex items-center gap-1.5">
        {detail.reviewers.length ? (
          <span className="flex -space-x-1.5">
            {detail.reviewers.map((name) => {
              const outcome = outcomes.get(name);
              const said = outcome ? `${name} — ${reviewOutcomeLabels[outcome]}` : name;
              return (
                <Tip key={name} label={said}>
                  <span
                    aria-label={said}
                    className={cn(
                      // The band shows the verdict; the panel-coloured ring keeps each avatar
                      // whole where the next one overlaps it.
                      "relative inline-flex rounded-full p-0.5 ring-2 ring-panel",
                      outcome ? band[outcome] : "bg-panel",
                    )}
                  >
                    <span className="inline-flex rounded-full bg-panel">
                      <PrAvatar name={name} url={detail.reviewerAvatars?.[name]} />
                    </span>
                  </span>
                </Tip>
              );
            })}
          </span>
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
