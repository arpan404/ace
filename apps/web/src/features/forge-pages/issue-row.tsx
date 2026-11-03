import { type LinkedThread } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgeIssueRow } from "@ace/protocol";
import { useToast } from "@/components/ui/toast.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { Avatars, IssueStateGlyph } from "./marks.tsx";
import { Age, Comments, Dot, ProjectTag, RowActions, rowClass, Thread } from "./row-parts.tsx";

/**
 * One issue: its state glyph and title, its comments and assignees; then its project (when the
 * list shows more than one), number, author, labels, milestone, thread and age.
 */
export function IssueRow(props: {
  project: string;
  /** The project's name, shown at the start of line 2; none when the list shows one project. */
  projectName?: string | undefined;
  row: ForgeIssueRow;
  /** The list's address, so the issue's page can return to it as it was. */
  back: string;
  thread: LinkedThread | undefined;
  /** The last of its group: no rule under it. */
  last?: boolean | undefined;
}) {
  const { row } = props;
  const navigate = useNavigate();
  const toast = useToast();
  const openWeb = useOpenWebAddress();
  return (
    <div className={cn("group/row relative", !props.last && "border-b border-border")}>
      <Link
        to="/issues/$project/$number"
        params={{ project: props.project, number: String(row.ref.number) }}
        search={{ back: props.back }}
        data-view-row=""
        className={rowClass}
      >
        <span className="pt-0.5">
          <IssueStateGlyph state={row.state} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              data-view-row-title=""
              className="min-w-0 truncate text-ui font-medium text-foreground"
            >
              {row.title}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
              <Comments count={row.commentCount} />
              <Avatars people={row.assignees} avatars={row.avatars} label="Assignees" />
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-meta text-subtle-foreground">
            {props.projectName && (
              <>
                <ProjectTag id={props.project} name={props.projectName} />
                <Dot />
              </>
            )}
            <span className="shrink-0 tabular-nums">#{row.ref.number}</span>
            <Dot />
            <span className="max-w-40 shrink-0 truncate">{row.author}</span>
            {row.labels.length > 0 && (
              <>
                <Dot />
                <span className="min-w-0 truncate">{row.labels.join(", ")}</span>
              </>
            )}
            {row.milestone && (
              <>
                <Dot />
                <span className="truncate">{row.milestone}</span>
              </>
            )}
            {props.thread && (
              <>
                <Dot />
                <Thread thread={props.thread} />
              </>
            )}
            <span className="ml-auto pl-2 text-subtle-foreground">
              <Age at={row.updatedAt} />
            </span>
          </span>
        </span>
      </Link>
      <RowActions
        url={row.url}
        onNewThread={() =>
          void navigate({ to: "/new", search: { project: props.project, issue: row.url } })
        }
        onOpenExternal={() =>
          void openWeb(row.url).catch(() => toast.error({ title: "Couldn't open GitHub" }))
        }
      />
    </div>
  );
}
