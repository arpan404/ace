import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgePrRow } from "@ace/protocol";
import type { LocalCheckResult } from "@ace/ui-core";
import { DiffStat } from "@/components/diff-stat.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { cn } from "@/lib/cn.ts";
import type { LinkedThread } from "./linked-threads.ts";
import { LabelPill } from "@/components/forge-marks.tsx";
import { Avatars, ChecksMark, PrStateGlyph, ReviewMark } from "./marks.tsx";
import { StepButton, StepSpace } from "./pr-step.tsx";
import {
  Age,
  Author,
  Comments,
  middleTruncate,
  RowActions,
  rowClass,
  Thread,
} from "./row-parts.tsx";

/** The row's next step as a button, or a quiet word when it waits on someone else. */
export interface RowStepView {
  /** The button: its word and what pressing it does. */
  action?:
    | {
        label: string;
        pressed?: boolean | undefined;
        /** Why it can't be pressed now. */
        disabled?: string | undefined;
        onPress(): void;
      }
    | undefined;
  /** "Checks running", "Waiting on review". */
  quiet?: string | undefined;
}

/**
 * One pull request: glyph, number, title and labels, with its review, checks, comments, size
 * and people at the right; then author, branches, thread and age, and its next step. The step's
 * button sits outside the row's link, over space the link keeps for it.
 */
export function PrRow(props: {
  project: string;
  row: ForgePrRow;
  /** The list's address, so the pull request's page can return to it as it was. */
  back: string;
  thread: LinkedThread | undefined;
  local?: LocalCheckResult;
  step?: RowStepView | undefined;
  /** In the merge selection: the row takes the selected fill. */
  selected?: boolean | undefined;
}) {
  const { row, step } = props;
  const navigate = useNavigate();
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const people = [...new Set([...(row.reviewers ?? []), ...(row.assignees ?? [])])];
  const action = step?.action;
  // Space on a selectable row toggles it, as its Merge button does.
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== " " || action?.pressed === undefined || action.disabled) return;
    event.preventDefault();
    action.onPress();
  };
  return (
    <li className="group/row relative border-b border-border last:border-b-0">
      <Link
        to="/pulls/$project/$number"
        params={{ project: props.project, number: String(row.ref.number) }}
        search={{ back: props.back }}
        data-view-row=""
        onKeyDown={onKeyDown}
        className={cn(
          rowClass,
          "group-hover/row:bg-hover",
          props.selected && "bg-active group-hover/row:bg-active hover:bg-active",
        )}
      >
        <span className="pt-0.5">
          <PrStateGlyph state={row.state} conflicting={row.conflicting} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-xs text-subtle-foreground tabular-nums">
              #{row.ref.number}
            </span>
            <span
              data-view-row-title=""
              className="min-w-0 truncate text-ui font-medium text-foreground"
            >
              {row.title}
            </span>
            <span className="hidden min-w-0 shrink items-center gap-1 overflow-hidden @xl/list:flex">
              {row.labels.map((label) => (
                <LabelPill key={label} name={label} color={row.labelColors?.[label]} />
              ))}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
              <ReviewMark decision={row.reviewDecision} />
              <ChecksMark ci={row.ci} local={props.local} />
              <Comments count={row.commentCount} />
              {row.additions !== undefined && row.deletions !== undefined && (
                <DiffStat additions={row.additions} deletions={row.deletions} />
              )}
              <Avatars people={people} avatars={row.avatars} label="Reviewers and assignees" />
            </span>
          </span>
          <span className="flex min-h-5 min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
            <Author login={row.author} avatar={row.avatars?.[row.author] ?? row.authorAvatarUrl} />
            {row.headBranch && row.baseBranch && (
              <>
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
                <span
                  className="min-w-0 truncate font-mono text-xs text-subtle-foreground"
                  title={`${row.headBranch} → ${row.baseBranch}`}
                >
                  {`${middleTruncate(row.headBranch, 32)} → ${middleTruncate(row.baseBranch, 20)}`}
                </span>
              </>
            )}
            {props.thread && (
              <>
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
                <Thread thread={props.thread} />
              </>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-subtle-foreground">
              {step?.quiet && (
                <>
                  <span>{step.quiet}</span>
                  <span aria-hidden>·</span>
                </>
              )}
              <Age at={row.updatedAt} />
            </span>
            <StepSpace label={action?.pressed ? "Selected" : action?.label} />
          </span>
        </span>
      </Link>
      {action && (
        <StepButton
          label={action.label}
          title={`#${row.ref.number} ${row.title}`}
          pressed={action.pressed}
          disabled={action.disabled}
          onPress={action.onPress}
        />
      )}
      <RowActions
        url={row.url}
        onNewThread={() =>
          void navigate({ to: "/new", search: { project: props.project, pullRequest: row.url } })
        }
        onOpenExternal={() =>
          void openWeb(row.url).catch(() => toast.error({ title: "Couldn't open GitHub" }))
        }
      />
    </li>
  );
}
