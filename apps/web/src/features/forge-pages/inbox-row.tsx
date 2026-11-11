import type { MouseEvent, ReactNode } from "react";
import { BellSlashIcon, CheckIcon, EnvelopeOpenIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ForgeInboxRow } from "@ace/protocol";
import { inboxTarget } from "@ace/ui-core";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { cn } from "@/lib/cn.ts";
import { InboxTypeIcon } from "./marks.tsx";
import { Ago, onModifiedClick, RowShell } from "./row-parts.tsx";

/** Where the row goes: ace's PR or issue page, else nothing (it opens on GitHub). */
export interface InboxRowTarget {
  project: string;
  /** The repository in the address when it isn't the project's own. */
  repo: string | undefined;
  /** The list's address, so the page can come back to it. */
  back: string;
}

/** GitHub's reason as it says it in the list: "review requested", "ci activity". */
const reasonWords = (reason: string) => reason.replace(/[_-]+/g, " ").toLowerCase();

/**
 * One notification, as GitHub lists it: its box, the unread dot, the subject's mark; then
 * "owner/repo #123" over the title; at the right why it came and when. Hovering or focusing it
 * swaps the time for Done, Unsubscribe (which also marks it done) and Mark read. Opening it
 * marks it read; ⌘/Ctrl-click and the right-click menu open it on GitHub.
 */
export function InboxRow(props: {
  row: ForgeInboxRow;
  to: InboxRowTarget;
  selected: boolean;
  onSelect(selected: boolean): void;
  onOpenWeb(url: string): void;
  onWrite(action: "read" | "done" | "unsubscribe"): void;
  last?: boolean | undefined;
}) {
  const { row, to } = props;
  const target = inboxTarget(row);
  const markRead = () => {
    if (row.unread) props.onWrite("read");
  };
  const body: ReactNode = (
    <>
      <span className="block truncate text-xs text-muted-foreground">
        {row.repository.owner}/{row.repository.name}
        {row.number !== undefined && <span className="tabular-nums"> #{row.number}</span>}
      </span>
      {row.unread && <span className="sr-only">Unread,</span>}
      <span
        data-view-row-title=""
        className={cn(
          "block truncate text-ui",
          row.unread ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {row.title}
      </span>
    </>
  );
  const openOnGitHub = (event: MouseEvent<HTMLElement>) => {
    if (!row.url || !(event.metaKey || event.ctrlKey)) return false;
    markRead();
    onModifiedClick(row.url, props.onOpenWeb)(event);
    return true;
  };
  const linkClass = "block min-w-0 flex-1 rounded-sm text-left focus-ring";
  return (
    <RowShell
      label={row.title}
      url={row.url}
      forge={row.repository.forge}
      last={props.last}
      selected={props.selected}
      menu={
        <>
          {row.unread && <MenuItem onClick={() => props.onWrite("read")}>Mark as read</MenuItem>}
          <MenuItem onClick={() => props.onWrite("done")}>Mark as done</MenuItem>
          <MenuItem onClick={() => props.onWrite("unsubscribe")}>Unsubscribe</MenuItem>
        </>
      }
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-3 px-4 py-2 transition-colors duration-(--motion-fast)",
          !props.selected && "group-focus-within/row:bg-hover group-hover/row:bg-hover",
        )}
      >
        <Checkbox
          aria-label={`Select ${row.title}`}
          checked={props.selected}
          onCheckedChange={(checked: boolean) => props.onSelect(checked)}
        />
        <span aria-hidden className="grid w-2 shrink-0 place-items-center">
          {row.unread && <span className="size-2 rounded-full bg-status-working" />}
        </span>
        <InboxTypeIcon row={row} />
        {target.kind === "web" ? (
          <button
            type="button"
            data-view-row=""
            className={linkClass}
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
            className={linkClass}
            onClick={(event) => {
              if (!openOnGitHub(event)) markRead();
            }}
          >
            {body}
          </Link>
        )}
        <span className="hidden shrink-0 text-xs text-muted-foreground @min-[34rem]/list:inline">
          {reasonWords(row.reason)}
        </span>
        <span className="flex w-24 shrink-0 items-center justify-end text-xs text-muted-foreground">
          <span className="tabular-nums group-focus-within/row:hidden group-hover/row:hidden">
            <Ago at={row.updatedAt} />
          </span>
          <span className="hidden items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
            <IconButton
              icon={CheckIcon}
              label="Done"
              size="sm"
              onClick={() => props.onWrite("done")}
            />
            <IconButton
              icon={BellSlashIcon}
              label="Unsubscribe"
              size="sm"
              onClick={() => props.onWrite("unsubscribe")}
            />
            {row.unread && (
              <IconButton
                icon={EnvelopeOpenIcon}
                label="Mark read"
                size="sm"
                onClick={() => props.onWrite("read")}
              />
            )}
          </span>
        </span>
      </div>
    </RowShell>
  );
}
