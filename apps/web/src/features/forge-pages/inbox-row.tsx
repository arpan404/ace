import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ForgeInboxRow } from "@ace/protocol";
import { inboxReasonWords, inboxTarget, inboxTypeWords } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { IssueStateWord, PrStateWord } from "./marks.tsx";
import { Age, Dot, ProjectTag, rowClass } from "./row-parts.tsx";

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
 * state in words when that matters), then its repository, number, why it arrived and how long ago. Opening it
 * marks it read. Hover or focus shows Mark read, Mark done and Unsubscribe (which also marks it
 * done).
 */
export function InboxRow(props: {
  row: ForgeInboxRow;
  to: InboxRowTarget;
  onOpenWeb(url: string): void;
  onWrite(action: "read" | "done" | "unsubscribe"): void;
  /** The row's project, at the start of line 2, when the list shows more than one. */
  tag?: { id: string; name: string } | undefined;
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
          <span className="shrink-0">{inboxReasonWords(row.reason)}</span>
          {target.kind === "web" && inboxTypeWords(row.type) !== inboxReasonWords(row.reason) && (
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
  return (
    <div className={cn("group/row relative", !props.last && "border-b border-border")}>
      {target.kind === "web" ? (
        <button
          type="button"
          data-view-row=""
          className={rowClass}
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
          className={rowClass}
          onClick={markRead}
        >
          {body}
        </Link>
      )}
      <span className="absolute top-1.5 right-[calc(var(--forge-gutter)-0.5rem)] hidden items-center gap-0.5 rounded-md bg-hover group-focus-within/row:flex group-hover/row:flex">
        {row.unread && (
          <Button size="xs" variant="ghost" onClick={() => props.onWrite("read")}>
            Mark read
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => props.onWrite("done")}>
          Mark done
        </Button>
        <Button size="xs" variant="ghost" onClick={() => props.onWrite("unsubscribe")}>
          Unsubscribe
        </Button>
        {row.url && (
          <IconButton
            size="sm"
            icon={ArrowSquareOutIcon}
            label="Open on GitHub"
            onClick={() => props.onOpenWeb(row.url ?? "")}
          />
        )}
      </span>
    </div>
  );
}
