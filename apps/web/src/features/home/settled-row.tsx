import { useSidebarThread } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useNow } from "@/lib/time.ts";
import { formatAge, isSnoozed, isUnread } from "@ace/ui-core";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { StatusMark } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useOrganizer, useThreadMark } from "./use-organizer.ts";

/** A compact settled row: title and age, Unsettle on hover. Opening it keeps it settled. */
export function SettledRow(props: { threadId: string }) {
  const entry = useSidebarThread(props.threadId);
  const mark = useThreadMark(props.threadId);
  const organizer = useOrganizer();
  const now = useNow();
  const [renaming, setRenaming] = useState(false);
  if (!entry) return null;
  const title = mark?.title ?? entry.title;
  const state = {
    settled: true,
    unread: isUnread(entry, mark, organizer.getState().baseline),
    pinned: mark?.pinned === true,
    snoozed: isSnoozed(mark, now),
  };
  const row =
    "flex h-[30px] w-full items-center gap-2 rounded-md px-[11px] text-sm text-subtle-foreground outline-none transition-colors duration-150";
  return (
    <ThreadMenu entry={entry} state={state} onRename={() => setRenaming(true)}>
      <div className="group/row relative">
        {renaming ? (
          <div className={`${row} bg-sidebar-accent`}>
            <RenameField entry={entry} title={title} onDone={() => setRenaming(false)} />
          </div>
        ) : (
          <Link
            to="/t/$threadId"
            params={{ threadId: entry.id }}
            className={`${row} group-hover/row:bg-sidebar-accent group-hover/row:text-muted-foreground focus-visible:bg-sidebar-accent data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)] data-[status=active]:text-foreground`}
          >
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <StatusMark status={entry.status} />
            <span className="text-[11px] group-focus-within/row:invisible group-hover/row:invisible">
              {formatAge(entry.updatedAt, now)}
            </span>
          </Link>
        )}
        {!renaming && (
          <RowActions
            entry={entry}
            settled
            snoozed={state.snoozed}
            className="top-[3px] right-1.5"
          />
        )}
      </div>
    </ThreadMenu>
  );
}
