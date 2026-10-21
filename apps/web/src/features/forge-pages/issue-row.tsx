import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgeIssueRow } from "@ace/protocol";
import { useToast } from "@/components/ui/toast.tsx";
import { openExternal } from "@/boot/open-external.ts";
import type { LinkedThread } from "./linked-threads.ts";
import { Avatars, IssueStateGlyph, LabelPill } from "./marks.tsx";
import { Age, Author, Comments, RowActions, rowClass, Thread } from "./row-parts.tsx";

/** One issue: glyph, number, title and labels, its comments and assignees; then author and age. */
export function IssueRow(props: {
  project: string;
  row: ForgeIssueRow;
  selected: boolean;
  thread: LinkedThread | undefined;
}) {
  const { row } = props;
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <li className="group/row relative border-b border-border last:border-b-0">
      <Link
        from="/issues"
        to="/issues"
        search={(current) => ({ ...current, issue: row.ref.number })}
        aria-current={props.selected ? "true" : undefined}
        data-view-row=""
        className={rowClass}
      >
        <span className="pt-0.5">
          <IssueStateGlyph state={row.state} />
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
              <Comments count={row.commentCount} />
              <Avatars people={row.assignees} avatars={row.avatars} label="Assignees" />
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
            <Author login={row.author} avatar={row.avatars?.[row.author] ?? row.authorAvatarUrl} />
            {row.milestone && (
              <>
                <span aria-hidden className="text-subtle-foreground">
                  ·
                </span>
                <span className="truncate">{row.milestone}</span>
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
          void openExternal(row.url).catch(() => toast.error({ title: "Couldn't open GitHub" }))
        }
      />
    </li>
  );
}
