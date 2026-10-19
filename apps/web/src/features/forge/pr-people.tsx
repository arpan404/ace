import { PlusIcon, TagIcon } from "@phosphor-icons/react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { PrAvatar } from "./pr-presentation.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { reviewerOutcomes, reviewOutcomeLabels, type ReviewOutcome } from "./pr-summary-model.ts";

const ring: Record<ReviewOutcome, string> = {
  approved: "ring-status-done",
  changes: "ring-status-failed",
  commented: "ring-border",
  dismissed: "ring-border opacity-50",
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
  return (
    <div
      id="pr-reviewers"
      className="flex min-h-8 scroll-mt-2 flex-wrap items-center gap-x-3 gap-y-1"
    >
      <div role="group" aria-label="Reviewers" className="flex items-center gap-1.5">
        {detail.reviewers.length ? (
          <span className="flex -space-x-1">
            {detail.reviewers.map((name) => {
              const outcome = outcomes.get(name);
              const said = outcome ? `${name} — ${reviewOutcomeLabels[outcome]}` : name;
              return (
                <Tip key={name} label={said}>
                  <span
                    aria-label={said}
                    className={cn(
                      "inline-flex rounded-full ring-2 ring-offset-1 ring-offset-panel",
                      outcome ? ring[outcome] : "ring-transparent",
                    )}
                  >
                    <PrAvatar name={name} url={detail.reviewerAvatars?.[name]} />
                  </span>
                </Tip>
              );
            })}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No reviewers</span>
        )}
        {reviewerPicker}
      </div>
      {(detail.labels.length > 0 || labelPicker) && (
        <div
          role="group"
          aria-label="Labels"
          className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1"
        >
          {detail.labels.map((label) => (
            <span
              key={label}
              title={label}
              className="max-w-48 truncate rounded-xs bg-accent px-1.5 text-xs leading-5 text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {labelPicker}
        </div>
      )}
    </div>
  );
}
