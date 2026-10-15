import { currentAttention } from "@ace/ui-core";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  useRefusedTitle,
  useSelected,
  useHomeSelection,
  useRenameTitle,
} from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { ThreadHoverContent, useThreadHover } from "./thread-hover-card.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { ProjectMark, RowStatus, RowContext, threadDetails, titleTone } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useThreadCard } from "./use-thread-card.ts";

// Rows are apart by space, not rules: the list sits inset from the sidebar's edges, and hover and
// the open thread fill a soft rounded box.
const row =
  "relative flex w-full items-center rounded-md px-3 text-left text-ui outline-none transition-colors duration-(--motion-fast)";

/** Every task shows project and status/time, title, then branch, environment and provider. */
export function ThreadRow(props: {
  threadId: string;
  settled: boolean;
  leaving?: boolean | undefined;
}) {
  const { settled } = props;
  const data = useThreadCard(props.threadId, settled, props.leaving);
  const selection = useHomeSelection();
  const editing = useRenameTitle(props.threadId);
  const hover = useThreadHover();
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing !== undefined || refused !== undefined;
  const started = useStartedTitle(props.threadId);
  const selected = useSelected(props.threadId);
  // One of its provider subagents open as the whole chat is still this thread.
  const current = useLocation({
    select: (location) =>
      location.pathname === `/t/${props.threadId}` ||
      location.pathname.startsWith(`/t/${props.threadId}/agents/`),
  });
  if (!data) return null;
  const { entry } = data;
  // A thread this window started reads its provisional title until the daemon titles it.
  const card =
    started && data.card.title === "New thread" ? { ...data.card, title: started } : data.card;
  const handle = card.flags.pinned && !renaming;
  const details = threadDetails(card);
  // The open thread reads at full contrast; every other row is as loud as its attention level.
  const attention = currentAttention(card.attention, current);
  const instance =
    (entry.switch?.state === "queued" ? entry.switch.selection.instanceId : undefined) ??
    entry.live?.account ??
    entry.execution?.instanceId;
  // Three lines of 16, 20 and 16px, 4px between each, 10px above and below.
  const height = "h-[80px] py-2.5";
  const title = (
    <div className="mt-1 flex min-w-0 items-center gap-1.5">
      <div className={cn("min-w-0 flex-1 truncate text-md leading-5", titleTone(attention))}>
        {renaming ? (
          <RenameField
            entry={entry}
            title={editing ?? refused ?? card.title}
            onDone={() => selection.finishRename()}
          />
        ) : (
          card.title
        )}
      </div>
    </div>
  );
  const body = (
    <div className="flex min-w-0 w-full flex-col">
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-meta leading-4 text-muted-foreground",
          // Reserve the top line's right end whenever its actions replace the status.
          !renaming &&
            "group-hover/row:pr-36 group-focus-within/row:pr-36 group-has-[[data-popup-open]]/row:pr-36",
        )}
      >
        <ProjectMark id={entry.workspaceId} badge={card.badge} />
        <span className="min-w-0 flex-1 truncate">{card.project}</span>
        <span
          className={cn(
            "flex shrink-0",
            !renaming &&
              "group-hover/row:hidden group-focus-within/row:hidden group-has-[[data-popup-open]]/row:hidden",
          )}
        >
          <RowStatus card={card} attention={attention} />
        </span>
      </div>
      {title}
      <div className="mt-1">
        <RowContext card={card} />
      </div>
    </div>
  );
  return (
    <>
      <HoverCard open={hover.open && !renaming} onOpenChange={hover.change}>
        <ThreadMenu
          entry={entry}
          state={card.flags}
          onRename={() => selection.rename(props.threadId, card.title)}
        >
          <HoverCardTrigger
            // Opens once the pointer settles; leaving the row closes it at once, so it never lingers.
            delay={450}
            closeDelay={0}
            onClick={() => hover.change(false)}
            onContextMenu={() => hover.change(false)}
            render={<div />}
            className="group/row relative"
            data-attention={attention.level}
            data-muted={attention.muted ? "" : undefined}
            // Settled rows stay out of picking and dragging, as they always have.
            {...(settled ? {} : { "data-thread-row": entry.id })}
          >
            {renaming ? (
              <div className={cn(row, height)}>{body}</div>
            ) : (
              <Link
                to="/t/$threadId"
                params={{ threadId: entry.id }}
                aria-label={`${card.title}${card.announceUnread ? ", unread" : ""}${selected ? ", selected" : ""}. ${details.join(", ")}`}
                data-row-focus=""
                draggable={false}
                className={cn(
                  row,
                  height,
                  // A keyboard-focused row draws the focus colour all round, plainly visible in the list.
                  "group/link focus-ring-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  // The open thread takes the fill every list shares for its current row (Settings,
                  // Skills, Automations); a picked one keeps its fill under the pointer.
                  current ? "bg-active" : selected ? "bg-sidebar-accent" : "hover:bg-hover",
                  handle && "pointer-coarse:pr-11",
                )}
              >
                {body}
              </Link>
            )}
            {handle && (
              // The list starts a touch drag from here (`touch-none`: the browser doesn't scroll)
              // and a keyboard move from Space or Enter. Hidden for a mouse: the row itself drags.
              <button
                type="button"
                data-drag-handle=""
                aria-label={`Move ${card.title}`}
                className="absolute top-1/2 right-0.5 hidden size-11 -translate-y-1/2 touch-none place-items-center rounded-md text-subtle-foreground select-none focus-ring pointer-coarse:grid"
              >
                <DotsSixVerticalIcon aria-hidden size={18} weight="bold" />
              </button>
            )}
            {!renaming && (
              <RowActions
                onRename={() => selection.rename(props.threadId, card.title)}
                onHover={() => hover.change(false)}
                entry={entry}
                flags={card.flags}
              />
            )}
          </HoverCardTrigger>
        </ThreadMenu>
        {hover.open && !renaming && (
          <ThreadHoverContent card={card} entry={entry} instance={instance} />
        )}
      </HoverCard>
    </>
  );
}
