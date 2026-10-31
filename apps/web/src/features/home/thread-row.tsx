import { currentAttention } from "@ace/ui-core";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import type { MachineIcon } from "@ace/protocol";
import type { ReactElement } from "react";
import { threadOn } from "@/lib/machine-routes.ts";
import { useMachines } from "@/lib/machines.ts";
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
import {
  BrowsingMark,
  ComputerUseMark,
  ProjectMark,
  RowStatus,
  RowContext,
  threadDetails,
  titleTone,
} from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useRowActive } from "./use-row-active.ts";
import { useThreadCard } from "./use-thread-card.ts";

// Rows are apart by space, not rules: the list sits inset from the sidebar's edges, and hover and
// the open thread fill a soft rounded box.
const row =
  "relative flex w-full items-center rounded-md px-2.5 text-left text-ui outline-none transition-colors duration-(--motion-fast)";

/**
 * Another machine's thread (ADR 0102), drawn under that machine's client. It opens on that
 * machine and is marked with it; its menus and hover actions run on that machine, and it is
 * picked, dragged and renamed under its list row id (`machine:[hostId,threadId]`).
 */
export interface RowMachine {
  id: string;
  name: string;
  icon: MachineIcon;
}

/** Whether the location shows `threadId` on `machine` (undefined: this window's own). */
export function useOpenHere(threadId: string, machine: string | undefined): boolean {
  // `?machine=` naming this window's own daemon is this window's own (ADR 0102).
  const own = useMachines().find((each) => each.primary)?.id;
  return useLocation({
    select: (location) => {
      const search: { machine?: unknown } = location.search;
      const shown = search.machine === own ? undefined : (search.machine ?? undefined);
      return (
        shown === machine &&
        (location.pathname === `/t/${threadId}` ||
          location.pathname.startsWith(`/t/${threadId}/agents/`))
      );
    },
  });
}

/**
 * Every task shows its title and status (or time) on one line, then its project, branch, pull
 * request and provider on the next.
 */
export function ThreadRow(props: {
  threadId: string;
  settled: boolean;
  leaving?: boolean | undefined;
  machine?: RowMachine | undefined;
  /** The list's id for the row, when it isn't the thread's own (another machine's thread). */
  rowId?: string | undefined;
  /** Drawn in its project's own list: the row doesn't repeat the project. */
  inProject?: boolean | undefined;
  /** In the Inbox: a dot at the row's left edge while the person hasn't seen it. */
  markUnread?: boolean | undefined;
}) {
  const { machine } = props;
  const { settled } = props;
  const rowId = props.rowId ?? props.threadId;
  const data = useThreadCard(props.threadId, settled, props.leaving);
  const selection = useHomeSelection();
  const editing = useRenameTitle(rowId);
  const hover = useThreadHover();
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing !== undefined || refused !== undefined;
  const started = useStartedTitle(props.threadId);
  const selected = useSelected(rowId);
  const rowActive = useRowActive();
  // One of its provider subagents open as the whole chat is still this thread.
  const current = useOpenHere(props.threadId, machine?.id);
  if (!data) return null;
  const { entry } = data;
  // A thread this window started reads its provisional title until the daemon titles it.
  const titled =
    started && data.card.title === "New thread" ? { ...data.card, title: started } : data.card;
  // Read under its own machine's client, the card would call that machine "this machine".
  const card = machine ? { ...titled, machine: machine.name, machineIcon: machine.icon } : titled;
  const handle = card.flags.pinned && !renaming;
  const details = threadDetails(card);
  // The open thread reads at full contrast; every other row is as loud as its attention level.
  const attention = currentAttention(card.attention, current);
  const instance =
    (entry.switch?.state === "queued" ? entry.switch.selection.instanceId : undefined) ??
    entry.live?.account ??
    entry.execution?.instanceId;
  const actions = rowActive.active && !renaming;
  // Two lines of 20 and 16px, 2px apart, 7px above and below: 52px.
  const height = "h-[52px] py-[7px]";
  const body = (
    <div className="flex min-w-0 w-full flex-col">
      <div
        className={cn(
          "flex min-w-0 items-center gap-2",
          // Under the pointer or keyboard focus the row's actions take the status slot: the title
          // stops short of them and the status steps aside, so only Snooze, Settle and ⋯ show.
          // An action's menu keeps them up after the pointer leaves; the status waits until it closes.
          actions ? "pr-30" : "group-has-[[data-popup-open]]/row:pr-30",
        )}
      >
        <div className={cn("min-w-0 flex-1 truncate text-md leading-5", titleTone(attention))}>
          {renaming ? (
            <RenameField
              entry={entry}
              rowId={rowId}
              title={editing ?? refused ?? card.title}
              onDone={() => selection.finishRename()}
            />
          ) : (
            card.title
          )}
        </div>
        {!actions && !renaming && (
          <span className="flex shrink-0 items-center gap-1.5 group-has-[[data-popup-open]]/row:hidden">
            <BrowsingMark threadId={props.threadId} />
            <ComputerUseMark threadId={props.threadId} />
            <RowStatus card={card} attention={attention} />
          </span>
        )}
      </div>
      <div className="mt-0.5">
        <RowContext
          card={card}
          project={
            props.inProject ? undefined : <ProjectMark id={entry.workspaceId} badge={card.badge} />
          }
        />
      </div>
    </div>
  );
  const rename = () => selection.rename(rowId, card.title);
  const menu = (trigger: ReactElement) => (
    <ThreadMenu entry={entry} rowId={rowId} state={card.flags} onRename={rename}>
      {trigger}
    </ThreadMenu>
  );
  return (
    <>
      <HoverCard open={hover.open && !renaming} onOpenChange={hover.change}>
        {menu(
          <HoverCardTrigger
            // Opens once the pointer settles; leaving the row closes it at once, so it never lingers.
            delay={450}
            closeDelay={0}
            onClick={() => hover.change(false)}
            onContextMenu={() => hover.change(false)}
            render={<div />}
            className="group/row relative"
            {...rowActive.handlers}
            data-attention={attention.level}
            data-muted={attention.muted ? "" : undefined}
            // Settled rows stay out of picking and dragging, as they always have.
            {...(settled ? {} : { "data-thread-row": rowId })}
          >
            {props.markUnread && card.flags.unread && (
              <span
                aria-hidden
                data-unread-dot=""
                className="pointer-events-none absolute top-[15px] left-0.5 z-[1] size-1.5 rounded-full bg-status-done"
              />
            )}
            {renaming ? (
              <div className={cn(row, height)}>{body}</div>
            ) : (
              <Link
                {...threadOn(machine?.id, entry.id)}
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
                onRename={rename}
                onHover={() => hover.change(false)}
                shown={actions}
                entry={entry}
                flags={card.flags}
              />
            )}
          </HoverCardTrigger>,
        )}
        {hover.open && !renaming && (
          <ThreadHoverContent card={card} entry={entry} instance={instance} />
        )}
      </HoverCard>
    </>
  );
}
