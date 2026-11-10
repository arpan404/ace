import { Button } from "@/components/ui/button.tsx";
import type { PrWorkspaceContext, PrWorkspaceExtensions } from "./pr-extensions.ts";
import { PrReviewers } from "./pr-reviewers.tsx";
import { reviewerRows, type ReviewerRow } from "@ace/ui-core";
import { usePrReviewers } from "./pr-reviewers-query.ts";
import { DetailRow } from "./pr-details.tsx";
import { PrAgentLine } from "./pr-agent-chip.tsx";
import { PrAvatar } from "./pr-presentation.tsx";
import { cn } from "@/lib/cn.ts";

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
            <span className="text-subtle-foreground">No reviews</span>
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
      {detail.relatedThreads.some((thread) => !thread.archived) && (
        <DetailRow label="Agent">
          <PrAgentLine detail={detail} />
        </DetailRow>
      )}
    </>
  );
}

/**
 * Labels as their names in ink, each led by a dot of its GitHub colour: the colour says which
 * label it is without turning the sidebar into a row of coloured badges.
 */
function LabelNames(props: {
  names: readonly string[];
  colors?: Readonly<Record<string, string>> | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 py-1">
      {props.names.map((name) => {
        const color = props.colors?.[name];
        return (
          <span key={name} className="inline-flex min-w-0 items-center gap-1.5 text-foreground/90">
            <span
              aria-hidden
              className={cn("size-2 shrink-0 rounded-full", !color && "bg-faint-foreground")}
              style={color ? { backgroundColor: `#${color}` } : undefined}
            />
            <span className="truncate">{name}</span>
          </span>
        );
      })}
    </span>
  );
}
