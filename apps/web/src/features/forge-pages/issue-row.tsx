import { type LinkedThread } from "@ace/ui-core";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ForgeIssueRow } from "@ace/protocol";
import { MenuItem } from "@/components/ui/menu.tsx";
import { repositoryParam } from "@/lib/pull-request-route.ts";
import { Avatars, CommentCount, IssueStateIcon, LabelPills } from "./marks.tsx";
import {
  Ago,
  Dot,
  onModifiedClick,
  RowShell,
  rowActionClass,
  useOpenOnHost,
} from "./row-parts.tsx";

/**
 * One issue, as GitHub lists it: the state mark; the title as the link and its labels; under
 * it "#246 opened 25m ago by sam", its milestone, the thread working on it and its project
 * when the list shows several. At the right Open thread (when one is linked), its assignees
 * and comments.
 */
export function IssueRow(props: {
  project: string;
  /** The project's name, on line 2; none when the list shows one project. */
  projectName?: string | undefined;
  /** "GitHub · acme/upstream", on line 2, when the project lists issues from several repositories. */
  repositoryName?: string | undefined;
  /** The row's repository is not the project's primary: its page names it. */
  otherRepository?: boolean | undefined;
  row: ForgeIssueRow;
  /** The list's address, so the issue's page can return to it as it was. */
  back: string;
  thread: LinkedThread | undefined;
  last?: boolean | undefined;
}) {
  const { row, thread } = props;
  const navigate = useNavigate();
  const openOnHost = useOpenOnHost();
  const openThread = thread
    ? () => void navigate({ to: "/t/$threadId", params: { threadId: thread.id } })
    : undefined;
  return (
    <RowShell
      label={`#${row.ref.number} ${row.title}`}
      url={row.url}
      forge={row.ref.repository.forge}
      last={props.last}
      menu={openThread && <MenuItem onClick={openThread}>Open thread</MenuItem>}
      onNewThread={() =>
        void navigate({ to: "/new", search: { project: props.project, issue: row.url } })
      }
    >
      <div className="flex min-w-0 items-start gap-2 px-4 py-2 transition-colors duration-(--motion-fast) group-focus-within/row:bg-hover group-hover/row:bg-hover">
        <span className="pt-1">
          <IssueStateIcon state={row.state} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="min-w-0 text-ui leading-6">
            <Link
              to="/issues/$project/$number"
              params={{ project: props.project, number: String(row.ref.number) }}
              search={{
                back: props.back,
                ...(props.otherRepository ? { repo: repositoryParam(row.ref.repository) } : {}),
              }}
              data-view-row=""
              onClick={onModifiedClick(row.url, openOnHost)}
              className="rounded-sm font-semibold break-words text-foreground focus-ring hover:text-link"
            >
              <span data-view-row-title="">{row.title}</span>
            </Link>
            <LabelPills names={row.labels} colors={row.labelColors} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {row.state === "closed" ? (
                <>
                  #{row.ref.number} by {row.author} was closed <Ago at={row.updatedAt} />
                </>
              ) : (
                <>
                  #{row.ref.number} opened <Ago at={row.createdAt} /> by {row.author}
                </>
              )}
            </span>
            {row.milestone && (
              <>
                <Dot />
                <span className="truncate">{row.milestone}</span>
              </>
            )}
            {thread && (
              <>
                <Dot />
                <span className="truncate" title={`Thread: ${thread.title}`}>
                  {thread.working ? "Agent working" : `Thread: ${thread.title}`}
                </span>
              </>
            )}
            {props.projectName && (
              <>
                <Dot />
                <span className="truncate">{props.projectName}</span>
              </>
            )}
            {props.repositoryName && (
              <>
                <Dot />
                <span className="truncate">{props.repositoryName}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5 pl-2">
          {openThread && (
            <button
              type="button"
              onClick={openThread}
              className={`${rowActionClass} hidden group-focus-within/row:inline-flex group-hover/row:inline-flex`}
            >
              Open thread
            </button>
          )}
          <Avatars people={row.assignees} avatars={row.avatars} label="Assignees" />
          <CommentCount count={row.commentCount} />
        </div>
      </div>
    </RowShell>
  );
}
