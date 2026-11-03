import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgePrRow } from "@ace/protocol";
import { middleTruncateText } from "@ace/ui-core";
import { DiffStat } from "@/components/diff-stat.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { cn } from "@/lib/cn.ts";
import { PrStateGlyph } from "./marks.tsx";
import { Age, Dot, ProjectTag, RowActions, rowClass } from "./row-parts.tsx";
import type { RowStepView } from "./row-steps.ts";

/** The right column's width: the status words and the action under them. */
const side = "[--row-side:6.5rem] @lg/list:[--row-side:8.5rem]";
const actionText =
  "inline-flex h-5 items-center rounded-sm px-1.5 text-xs font-medium text-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover disabled:opacity-50";

/**
 * One pull request: its state glyph, the title across the row, then its project (when the list
 * shows more than one), number, author, branch and size. At the right, its state in words in
 * its tone, and its age; hovering or focusing the row puts the next action (Review, Merge,
 * Update branch, Open thread) where the age was. The action sits outside the row's link.
 */
export function PrRow(props: {
  project: string;
  /** The project's name, shown at the start of line 2; none when the list shows one project. */
  projectName?: string | undefined;
  row: ForgePrRow;
  /** The list's address, so the pull request's page can return to it as it was. */
  back: string;
  step: RowStepView;
  /** In the merge selection: the row takes the selected fill. */
  selected?: boolean | undefined;
  /** The last of its group: no rule under it. */
  last?: boolean | undefined;
}) {
  const { row, step } = props;
  const navigate = useNavigate();
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  const { action, status } = step;
  const pressed = action.pressed === true;
  // Space on a selectable row toggles it, as its Merge button does.
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== " " || action.pressed === undefined || action.disabled) return;
    event.preventDefault();
    action.onPress();
  };
  const branch = row.headBranch;
  return (
    <div className={cn("group/row relative", side, !props.last && "border-b border-border")}>
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
          <span
            data-view-row-title=""
            className="min-w-0 truncate text-ui font-medium text-foreground"
          >
            {row.title}
          </span>
          <span className="flex min-h-5 min-w-0 items-center gap-1.5 text-meta text-subtle-foreground">
            {props.projectName && (
              <>
                <ProjectTag id={props.project} name={props.projectName} />
                <Dot />
              </>
            )}
            <span className="shrink-0 tabular-nums">#{row.ref.number}</span>
            <Dot />
            <span className="max-w-40 shrink-0 truncate">{row.author}</span>
            {branch && (
              // A narrow list leaves the branch to the pull request's page.
              <span className="hidden min-w-0 items-center gap-1.5 @xl/list:flex">
                <Dot />
                <span
                  className="min-w-0 truncate font-mono text-xs"
                  title={row.baseBranch ? `${branch} → ${row.baseBranch}` : branch}
                >
                  {middleTruncateText(branch, 36)}
                </span>
              </span>
            )}
            {row.additions !== undefined && row.deletions !== undefined && (
              <>
                <Dot />
                <DiffStat
                  additions={row.additions}
                  deletions={row.deletions}
                  className="shrink-0 whitespace-nowrap"
                />
              </>
            )}
          </span>
        </span>
        <span className="flex w-(--row-side) shrink-0 flex-col items-end gap-1 pl-2 text-meta">
          <span
            data-tone={status.tone}
            className={cn(
              "max-w-full truncate",
              status.tone ? "text-(--tone-text)" : "text-foreground",
            )}
          >
            {status.words}
          </span>
          <span
            className={cn(
              "flex min-h-5 items-center text-subtle-foreground",
              !pressed && "group-focus-within/row:invisible group-hover/row:invisible",
              pressed && "invisible",
            )}
          >
            <Age at={row.updatedAt} />
          </span>
        </span>
      </Link>
      <button
        type="button"
        aria-pressed={action.pressed}
        aria-label={`${pressed ? "Selected" : action.label}: #${row.ref.number} ${row.title}`}
        title={action.disabled}
        disabled={action.disabled !== undefined}
        onClick={action.onPress}
        className={cn(
          actionText,
          "absolute right-[calc(var(--forge-gutter)-0.375rem)] bottom-2.5",
          !pressed &&
            "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus:opacity-100",
        )}
      >
        {pressed ? "Selected" : action.label}
      </button>
      <RowActions
        beside
        url={row.url}
        onNewThread={() =>
          void navigate({ to: "/new", search: { project: props.project, pullRequest: row.url } })
        }
        onOpenExternal={() =>
          void openWeb(row.url).catch(() => toast.error({ title: "Couldn't open GitHub" }))
        }
      />
    </div>
  );
}
