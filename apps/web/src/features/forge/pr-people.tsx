import { LabelPill } from "@/components/forge-marks.tsx";
import { Button } from "@/components/ui/button.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrReviewers } from "./pr-reviewers.tsx";
import { reviewerRows, type ReviewerRow } from "@ace/ui-core";
import { usePrReviewers } from "./pr-reviewers-query.ts";
import { DetailRow } from "./pr-details.tsx";
import { PrAgentLine } from "./pr-agent-chip.tsx";
import { PrAvatar } from "./pr-presentation.tsx";

/**
 * The people on the pull request, as the About section's first rows: each reviewer with their
 * latest verdict in words, who is assigned, the labels, and the agent working on it live.
 */
export function PrPeople(props: {
  context: PrWorkspaceContext;
  extensions?: PrWorkspaceExtensions | undefined;
  /** Who is assigned, once the lifecycle read says; undefined hides the row. */
  assignees?: readonly string[] | undefined;
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
      <Button variant="ghost" size="xs" disabled={disabled} onClick={props.onRequestReview}>
        Request review
      </Button>
    ));
  const labelPicker =
    props.extensions?.labels?.(props.context) ??
    (props.onEdit && (
      <Button variant="ghost" size="xs" disabled={disabled} onClick={props.onEdit}>
        Edit
      </Button>
    ));
  const assignees = props.assignees;
  return (
    <>
      <DetailRow label="Reviewers" action={reviewerPicker}>
        <div id="pr-reviewers" role="group" aria-label="Reviewers" className="scroll-mt-10 py-1">
          {rows.length ? (
            <PrReviewers
              rows={rows}
              value={reviewers.data}
              disabled={disabled}
              onDismissed={() => void reviewers.refetch()}
              onRequestReview={props.onRequestReview}
            />
          ) : (
            <span className="text-subtle-foreground">No reviewers yet</span>
          )}
        </div>
      </DetailRow>
      {assignees && (
        <DetailRow label={assignees.length === 1 ? "Assignee" : "Assignees"}>
          <span className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
            {assignees.length ? (
              assignees.map((login) => (
                <span key={login} className="inline-flex items-center gap-1.5 text-foreground">
                  <PrAvatar name={login} url={undefined} />
                  {login}
                </span>
              ))
            ) : (
              <span className="text-subtle-foreground">Nobody</span>
            )}
          </span>
        </DetailRow>
      )}
      {(detail.labels.length > 0 || labelPicker) && (
        <DetailRow label="Labels" action={labelPicker}>
          <div
            role="group"
            aria-label="Labels"
            className="flex min-h-7 flex-wrap items-center gap-1"
          >
            {detail.labels.length ? (
              detail.labels.map((label) => (
                <LabelPill key={label} name={label} color={detail.labelColors?.[label]} />
              ))
            ) : (
              <span className="text-subtle-foreground">None</span>
            )}
          </div>
        </DetailRow>
      )}
      {detail.relatedThreads.some((thread) => !thread.archived) && (
        <DetailRow label="Agent">
          <PrAgentLine detail={detail} />
        </DetailRow>
      )}
    </>
  );
}
