import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgePrRow } from "@ace/protocol";
import { prWords, reviewMark } from "@ace/ui-core";
import { DiffCounts } from "@/components/diff-stat.tsx";
import { cn } from "@/lib/cn.ts";
import { Avatars, ChecksMark, CommentCount, LabelPills, PrStateIcon } from "./marks.tsx";
import {
  Ago,
  Dot,
  onModifiedClick,
  RowShell,
  rowActionClass,
  useOpenOnGitHub,
} from "./row-parts.tsx";
import type { RowStepView } from "./row-steps.ts";

/**
 * One pull request, as GitHub lists it: the state mark; the title as the link, its labels and
 * its checks' mark; under it "#229 opened 2h ago by sam", draft, the review decision, what ace
 * knows of it (an agent working, who asked you) and its project when the list shows several.
 * At the right its assignees and comments; hovering or focusing the row puts its next action
 * there too. ⌘/Ctrl-click or the right-click menu opens it on GitHub.
 */
export function PrRow(props: {
  project: string;
  /** The project's name, on line 2; none when the list shows one project. */
  projectName?: string | undefined;
  row: ForgePrRow;
  /** The list's address, so the pull request's page can return to it as it was. */
  back: string;
  step: RowStepView;
  /** In the merge selection: the row takes the selected fill. */
  selected?: boolean | undefined;
  last?: boolean | undefined;
}) {
  const { row, step } = props;
  const navigate = useNavigate();
  const openOnGitHub = useOpenOnGitHub();
  const { action, status } = step;
  const pressed = action.pressed === true;
  // Space on a selectable row toggles it, as its Merge button does.
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== " " || action.pressed === undefined || action.disabled) return;
    event.preventDefault();
    action.onPress();
  };
  const review = reviewMark(row.reviewDecision)?.word;
  // What ace adds to GitHub's line, when it says more than the state or the review.
  const extra =
    status.words !== prWords[row.state] && status.words !== review ? status.words : undefined;
  const opened = row.createdAt ?? row.updatedAt;
  return (
    <RowShell
      label={`#${row.ref.number} ${row.title}`}
      url={row.url}
      selected={props.selected}
      last={props.last}
      onNewThread={() =>
        void navigate({ to: "/new", search: { project: props.project, pullRequest: row.url } })
      }
    >
      <div className="flex min-w-0 items-start gap-2 px-4 py-2 transition-colors duration-(--motion-fast) group-focus-within/row:bg-hover group-hover/row:bg-hover">
        <span className="pt-1">
          <PrStateIcon state={row.state} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="min-w-0 text-ui leading-6">
            <Link
              to="/pulls/$project/$number"
              params={{ project: props.project, number: String(row.ref.number) }}
              search={{ back: props.back }}
              data-view-row=""
              onKeyDown={onKeyDown}
              onClick={onModifiedClick(row.url, openOnGitHub)}
              className="rounded-sm font-semibold break-words text-foreground focus-ring hover:text-link"
            >
              <span data-view-row-title="">{row.title}</span>
            </Link>
            <LabelPills names={row.labels} colors={row.labelColors} />
            {row.ci && (
              <span className="ml-1.5">
                <ChecksMark ci={row.ci} />
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              #{row.ref.number} {row.createdAt ? "opened" : "updated"} <Ago at={opened} /> by{" "}
              {row.author}
            </span>
            {row.state === "draft" && (
              <>
                <Dot />
                <span>Draft</span>
              </>
            )}
            {review && row.state !== "merged" && row.state !== "closed" && (
              <>
                <Dot />
                <span>{review}</span>
              </>
            )}
            {extra && (
              <>
                <Dot />
                <span>{extra}</span>
              </>
            )}
            {props.projectName && (
              <>
                <Dot />
                <span className="truncate">{props.projectName}</span>
              </>
            )}
            {row.additions !== undefined && row.deletions !== undefined && (
              <>
                <Dot />
                <DiffCounts additions={row.additions} deletions={row.deletions} />
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5 pl-2">
          <button
            type="button"
            aria-pressed={action.pressed}
            aria-label={`${pressed ? "Selected" : action.label}: #${row.ref.number} ${row.title}`}
            title={action.disabled}
            disabled={action.disabled !== undefined}
            onClick={action.onPress}
            className={cn(
              rowActionClass,
              "border border-border bg-background",
              pressed
                ? "inline-flex"
                : "hidden group-focus-within/row:inline-flex group-hover/row:inline-flex",
            )}
          >
            {pressed ? "Selected" : action.label}
          </button>
          <Avatars people={row.assignees ?? []} avatars={row.avatars} label="Assignees" />
          <CommentCount count={row.commentCount} />
        </div>
      </div>
    </RowShell>
  );
}
