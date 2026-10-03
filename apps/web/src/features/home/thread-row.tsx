import { useSidebarThread } from "@ace/client-react";
import { FolderSimpleIcon, GitBranchIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/cn.ts";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { useNow } from "@/lib/time.ts";
import { formatAge, isSnoozed, isUnread, describeWake } from "@ace/ui-core";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { ProviderMark, RowGlyphs, StatusMark, runningSubagents } from "./row-parts.tsx";
import { useThreadDetails } from "./thread-details.ts";
import { ThreadMenu, type RowState } from "./thread-menu.tsx";
import { useOrganizer, useThreadMark } from "./use-organizer.ts";

/**
 * One Home card: project and machine on line one with the age, the title on line two (medium
 * when it needs you, is unread or open), branch and PR on line three with the status mark and
 * provider. Settle and Snooze appear on hover; right-click opens the full menu. Subscribes to
 * its own entry and mark, so other threads' updates skip it.
 */
export function ThreadRow(props: { threadId: string }) {
  const entry = useSidebarThread(props.threadId);
  const mark = useThreadMark(props.threadId);
  const details = useThreadDetails(props.threadId);
  const organizer = useOrganizer();
  const now = useNow();
  const [renaming, setRenaming] = useState(false);
  if (!entry) return null;
  // The baseline is fixed when the organizer is first created, so reading it once is enough.
  const { baseline } = organizer.getState();
  const title = mark?.title ?? entry.title;
  const snoozed = isSnoozed(mark, now);
  const state: RowState = {
    settled: false,
    unread: isUnread(entry, mark, baseline),
    pinned: mark?.pinned === true,
    snoozed,
  };
  const emphasis = entry.status.state === "needs_you" || state.unread;
  const lines = (
    <>
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-subtle-foreground">
        <span className="truncate">{entry.workspaceId}</span>
        <RowGlyphs
          machine={details?.machine}
          pinned={state.pinned}
          {...(snoozed && mark?.snoozedUntil ? { wake: describeWake(mark.snoozedUntil, now) } : {})}
        />
      </span>
      <span className="self-center text-xs whitespace-nowrap text-subtle-foreground group-focus-within/row:invisible group-hover/row:invisible">
        {formatAge(entry.updatedAt, now)}
      </span>
      {renaming ? (
        <RenameField entry={entry} title={title} onDone={() => setRenaming(false)} />
      ) : (
        <span
          className={cn(
            "col-span-2 line-clamp-2 text-base leading-[1.3] tracking-[-0.005em] text-muted-foreground compact:line-clamp-1",
            "group-data-[status=active]/link:font-medium group-data-[status=active]/link:text-foreground",
            emphasis && "font-medium text-foreground",
          )}
        >
          {title}
          {state.unread && entry.status.state !== "needs_you" && (
            <span className="sr-only">, unread</span>
          )}
        </span>
      )}
      <span className="flex min-w-0 items-center gap-[5px] font-mono text-[11px] text-subtle-foreground">
        {details && (
          <>
            <Icon icon={details.worktree ? FolderSimpleIcon : GitBranchIcon} size={12} />
            <span className="truncate">{details.branch}</span>
            {details.pr !== undefined && (
              <span className="shrink-0 font-sans text-xs">#{details.pr}</span>
            )}
          </>
        )}
      </span>
      <span className="flex items-center justify-end gap-2 whitespace-nowrap">
        <StatusMark status={entry.status} />
        <ProviderMark provider={entry.provider} subagents={runningSubagents(entry.status)} />
      </span>
    </>
  );
  const grid =
    "grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 rounded-md px-[11px] pt-[9px] pb-2.5 outline-none transition-colors duration-150 compact:pt-1.5 compact:pb-[7px]";
  return (
    <ThreadMenu entry={entry} state={state} onRename={() => setRenaming(true)}>
      <div className="group/row relative" data-thread-row={entry.id}>
        {renaming ? (
          <div className={cn(grid, "bg-sidebar-accent")}>{lines}</div>
        ) : (
          <Link
            to="/t/$threadId"
            params={{ threadId: entry.id }}
            className={cn(
              grid,
              "group/link group-hover/row:bg-sidebar-accent focus-visible:bg-sidebar-accent",
              "data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
            )}
          >
            {lines}
          </Link>
        )}
        {!renaming && <RowActions entry={entry} settled={false} snoozed={snoozed} />}
      </div>
    </ThreadMenu>
  );
}
