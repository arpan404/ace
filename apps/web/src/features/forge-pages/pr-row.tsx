import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgePrRow } from "@ace/protocol";
import { middleTruncateText, prWords } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { PrStateWord } from "./marks.tsx";
import {
  Age,
  Dot,
  onModifiedClick,
  ProjectTag,
  RowShell,
  rowActionClass,
  rowClass,
  useOpenOnGitHub,
} from "./row-parts.tsx";
import type { RowStepView } from "./row-steps.ts";

/**
 * One pull request: the title across the row (after "Draft", "Merged" or "Closed" when so), then
 * its project (when the list shows more than one), number and author; the branch joins them on a
 * wide list, or while the row is hovered or focused. At the right, its state in words in its
 * tone, and under it its size and age in quiet grey. Hovering or focusing the row puts its next
 * action and New thread there instead; ⌘/Ctrl-click or the right-click menu opens it on GitHub.
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
  const openOnGitHub = useOpenOnGitHub();
  const { action, status } = step;
  const pressed = action.pressed === true;
  // Space on a selectable row toggles it, as its Merge button does.
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>) => {
    if (event.key !== " " || action.pressed === undefined || action.disabled) return;
    event.preventDefault();
    action.onPress();
  };
  const branch = row.headBranch;
  const sized = row.additions !== undefined && row.deletions !== undefined;
  return (
    <RowShell
      label={`#${row.ref.number} ${row.title}`}
      url={row.url}
      pinned={pressed}
      selected={props.selected}
      last={props.last}
      onNewThread={() =>
        void navigate({ to: "/new", search: { project: props.project, pullRequest: row.url } })
      }
      actions={
        <button
          type="button"
          aria-pressed={action.pressed}
          aria-label={`${pressed ? "Selected" : action.label}: #${row.ref.number} ${row.title}`}
          title={action.disabled}
          disabled={action.disabled !== undefined}
          onClick={action.onPress}
          className={rowActionClass}
        >
          {pressed ? "Selected" : action.label}
        </button>
      }
    >
      <Link
        to="/pulls/$project/$number"
        params={{ project: props.project, number: String(row.ref.number) }}
        search={{ back: props.back }}
        data-view-row=""
        onKeyDown={onKeyDown}
        onClick={onModifiedClick(row.url, openOnGitHub)}
        className={cn(
          rowClass,
          "group-focus-within/row:bg-hover group-hover/row:bg-hover",
          props.selected &&
            "bg-active group-focus-within/row:bg-active group-hover/row:bg-active hover:bg-active",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            data-view-row-title=""
            className="min-w-0 truncate text-ui font-medium text-foreground"
          >
            {/* The right column may already say it ("Draft"); else it leads the title. */}
            {status.words !== prWords[row.state] && <PrStateWord state={row.state} />}
            {row.title}
          </span>
          <span className="flex min-h-5 min-w-0 items-center gap-1.5 text-meta text-subtle-foreground">
            {props.projectName && (
              <>
                <ProjectTag name={props.projectName} />
                <Dot />
              </>
            )}
            <span className="shrink-0 tabular-nums">#{row.ref.number}</span>
            <Dot />
            <span className="max-w-40 shrink-0 truncate">{row.author}</span>
            {branch && (
              // The branch is detail: a wide list shows it, a narrower one while the row is
              // hovered or focused.
              <span className="hidden min-w-0 items-center gap-1.5 group-focus-within/row:flex group-hover/row:flex @min-[1100px]/list:flex">
                <Dot />
                <span
                  className="min-w-0 truncate font-mono text-xs"
                  title={row.baseBranch ? `${branch} → ${row.baseBranch}` : branch}
                >
                  {middleTruncateText(branch, 36)}
                </span>
              </span>
            )}
          </span>
        </span>
        <span
          className={cn(
            "flex max-w-[45%] shrink-0 flex-col items-end gap-1 pl-3 text-meta",
            "group-focus-within/row:invisible group-hover/row:invisible",
            pressed && "invisible",
          )}
        >
          <span
            data-tone={status.tone}
            className={cn(
              "max-w-full truncate",
              status.tone ? "text-(--tone-text)" : "text-foreground",
            )}
          >
            {status.words}
          </span>
          <span className="flex min-h-5 items-center gap-1.5 whitespace-nowrap text-subtle-foreground tabular-nums">
            {sized && (
              <>
                <span title={`${row.additions} added, ${row.deletions} removed`}>
                  +{row.additions} −{row.deletions}
                </span>
                <Dot />
              </>
            )}
            <Age at={row.updatedAt} />
          </span>
        </span>
      </Link>
    </RowShell>
  );
}
