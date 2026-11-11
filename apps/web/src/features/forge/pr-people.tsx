import { can } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrReviewers } from "./pr-reviewers.tsx";
import { reviewerRows, type ReviewerRow } from "@ace/ui-core";
import { usePrReviewers } from "./pr-reviewers-query.ts";
import { DetailRow } from "./pr-detail-row.tsx";
import { PrAgentBlock } from "./pr-sidebar-blocks.tsx";
import { PrAvatar } from "./pr-presentation.tsx";
import { LabelPill } from "@/components/forge-marks.tsx";

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
    can(detail, "reviews.reviewers.request") &&
    (props.extensions?.reviewers?.(props.context) ??
      (props.onRequestReview && (
        <Button
          variant="ghost"
          size="xs"
          aria-label="Request review"
          disabled={disabled}
          onClick={props.onRequestReview}
        >
          Request
        </Button>
      )));
  const labelPicker =
    can(detail, "reviews.edit") &&
    (props.extensions?.labels?.(props.context) ??
      (props.onEdit && (
        <Button variant="ghost" size="xs" disabled={disabled} onClick={props.onEdit}>
          Edit
        </Button>
      )));
  const assignees = props.assignees;
  return (
    <>
      <PrAgentBlock detail={detail} />
      {(can(detail, "reviews.approvals.read") || can(detail, "reviews.approvals.write")) && (
        <DetailRow label="Reviewers" action={reviewerPicker}>
          <div id="pr-reviewers" role="group" aria-label="Reviewers" className="scroll-mt-10 py-1">
            {rows.length ? (
              <PrReviewers
                rows={rows.map((row) =>
                  Object.assign({}, row, {
                    // Asking and un-asking reviewers is its own capability; dismissing a
                    // review is an approval write.
                    canRerequest: row.canRerequest && can(detail, "reviews.reviewers.request"),
                    canRemove: row.canRemove && can(detail, "reviews.reviewers.request"),
                    canDismiss: row.canDismiss && can(detail, "reviews.approvals.write"),
                  }),
                )}
                value={reviewers.data}
                disabled={
                  disabled ||
                  !(
                    can(detail, "reviews.approvals.write") ||
                    can(detail, "reviews.reviewers.request")
                  )
                }
                onDismissed={() => void reviewers.refetch()}
                onRequestReview={props.onRequestReview}
              />
            ) : (
              <span className="text-subtle-foreground">No reviews</span>
            )}
          </div>
        </DetailRow>
      )}
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
              <span className="text-subtle-foreground">No one assigned</span>
            )}
          </span>
        </DetailRow>
      )}
      {(detail.labels.length > 0 || labelPicker) && (
        <DetailRow label="Labels" action={labelPicker}>
          <p aria-label="Labels" className="flex min-h-7 items-center">
            {detail.labels.length ? (
              <LabelNames names={detail.labels} colors={detail.labelColors} />
            ) : (
              <span className="text-subtle-foreground">None</span>
            )}
          </p>
        </DetailRow>
      )}
    </>
  );
}

/** Labels as GitHub's coloured pills, wrapping in the sidebar's width. */
function LabelNames(props: {
  names: readonly string[];
  colors?: Readonly<Record<string, string>> | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-wrap gap-1 py-1">
      {props.names.map((name) => (
        <LabelPill key={name} name={name} color={props.colors?.[name]} />
      ))}
    </span>
  );
}
