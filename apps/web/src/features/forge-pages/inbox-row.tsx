import type { MouseEvent, ReactNode } from "react";
import { MenuItem } from "@/components/ui/menu.tsx";
import { Link } from "@tanstack/react-router";
import type { ForgeInboxRow } from "@ace/protocol";
import { inboxTarget, inboxTypeWords, inboxWhyWords } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { IssueStateWord, PrStateWord } from "./marks.tsx";
import {
  Age,
  Dot,
  onModifiedClick,
  ProjectTag,
  RowShell,
  rowActionClass,
  rowClass,
} from "./row-parts.tsx";

/** A pull request's or issue's state in words before its title; other subjects say their type on line 2. */
function SubjectWord(props: { row: ForgeInboxRow }) {
  const { row } = props;
  if (row.type === "PullRequest" && row.state) return <PrStateWord state={row.state} />;
  if (row.type === "Issue" && (row.state === "open" || row.state === "closed"))
    return <IssueStateWord state={row.state} />;
  return null;
}

/** Where the row goes: ace's PR or issue page, else nothing (it opens on GitHub). */
export interface InboxRowTarget {
  project: string;
  /** The repository in the address when it isn't the project's own. */
  repo: string | undefined;
  /** The list's address, so the page can come back to it. */
  back: string;
}

/**
 * One notification at GitHub's density: the unread dot in the gutter, the title (after its
 * state in words when that matters), then its repository, number, why it reached the person in
 * their terms ("sam asked you to review") and how long ago. Opening it marks it read. Hover or
 * focus shows Mark read, Done and Unsubscribe (which also marks it done) as words at the right;
 * ⌘/Ctrl-click and the right-click menu open it on GitHub.
 */
export function InboxRow(props: {
  row: ForgeInboxRow;
  to: InboxRowTarget;
  onOpenWeb(url: string): void;
  onWrite(action: "read" | "done" | "unsubscribe"): void;
  /** The row's project, at the start of line 2, when the list shows more than one. */
  tag?: { id: string; name: string } | undefined;
  /** Who asked for the review, when a list already read the pull request. */
  asker?: string | undefined;
  /** The last of the list: no rule under it. */
  last?: boolean | undefined;
}) {
  const { row, to } = props;
  const target = inboxTarget(row);
  const markRead = () => {
    if (row.unread) props.onWrite("read");
  };
  const body: ReactNode = (
    <>
      {row.unread && (
        <span
          aria-hidden
          className="absolute top-[18px] left-[calc(var(--forge-gutter)/2-3px)] size-1.5 rounded-full bg-ring"
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          {row.unread && <span className="sr-only">Unread,</span>}
          <span
            data-view-row-title=""
            className={cn(
              "min-w-0 truncate text-ui",
              row.unread ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            <SubjectWord row={row} />
            {row.title}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
          {props.tag ? (
            <ProjectTag name={props.tag.name} />
          ) : (
            <span className="truncate">
              {row.repository.owner}/{row.repository.name}
            </span>
          )}
          {row.number !== undefined && (
            <>
              <Dot />
              <span className="shrink-0 tabular-nums">#{row.number}</span>
            </>
          )}
          <Dot />
          <span className="min-w-0 truncate">{inboxWhyWords(row, props.asker)}</span>
          {target.kind === "web" && inboxTypeWords(row.type) !== inboxWhyWords(row) && (
            <>
              <span aria-hidden className="text-subtle-foreground">
                ·
              </span>
              <span className="shrink-0 text-subtle-foreground">{inboxTypeWords(row.type)}</span>
            </>
          )}
          <span className="ml-auto pl-2 text-subtle-foreground">
            <Age at={row.updatedAt} />
          </span>
        </span>
      </span>
    </>
  );
  const openOnGitHub = (event: MouseEvent<HTMLElement>) => {
    if (!row.url || !(event.metaKey || event.ctrlKey)) return false;
    markRead();
    onModifiedClick(row.url, props.onOpenWeb)(event);
    return true;
  };
  const act = (label: string, action: "read" | "done" | "unsubscribe") => (
    <button type="button" className={rowActionClass} onClick={() => props.onWrite(action)}>
      {label}
    </button>
  );
  return (
    <RowShell
      label={row.title}
      url={row.url}
      last={props.last}
      menu={
        <>
          {row.unread && <MenuItem onClick={() => props.onWrite("read")}>Mark read</MenuItem>}
          <MenuItem onClick={() => props.onWrite("done")}>Done</MenuItem>
          <MenuItem onClick={() => props.onWrite("unsubscribe")}>Unsubscribe</MenuItem>
        </>
      }
      actions={
        <>
          {row.unread && (
            <>
              {act("Mark read", "read")}
              <Dot />
            </>
          )}
          {act("Done", "done")}
          <Dot />
          {act("Unsubscribe", "unsubscribe")}
        </>
      }
    >
      {target.kind === "web" ? (
        <button
          type="button"
          data-view-row=""
          className={cn(rowClass, "group-focus-within/row:bg-hover")}
          onClick={() => {
            markRead();
            props.onOpenWeb(target.url);
          }}
        >
          {body}
        </button>
      ) : (
        <Link
          to={target.kind === "pull" ? "/pulls/$project/$number" : "/issues/$project/$number"}
          params={{ project: to.project, number: String(target.number) }}
          search={{ back: to.back, ...(to.repo ? { repo: to.repo } : {}) }}
          data-view-row=""
          className={cn(rowClass, "group-focus-within/row:bg-hover")}
          onClick={(event) => {
            if (!openOnGitHub(event)) markRead();
          }}
        >
          {body}
        </Link>
      )}
    </RowShell>
  );
}
