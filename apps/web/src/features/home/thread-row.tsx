import { currentAttention } from "@ace/ui-core";
import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import type { MachineIcon } from "@ace/protocol";
import type { ComponentType, ReactElement } from "react";
import { threadOn } from "@/lib/machine-routes.ts";
import { useMachines } from "@/lib/machines.ts";
import {
  useRefusedTitle,
  useSelected,
  useHomeSelection,
  useRenameTitle,
} from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { ProjectMark } from "@/components/project-mark.tsx";
import { panelRowLine } from "@/components/ui/panel.tsx";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { ThreadHoverContent, useThreadHover } from "./thread-hover-card.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions, type RowActionsProps } from "./row-actions.tsx";
import { threadDetails } from "./row-parts.tsx";
import { RowIndicator } from "./row-indicator.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useRowActive } from "./use-row-active.ts";
import { useThreadCard } from "./use-thread-card.ts";

// The panel's one row line (`panelRowLine`), apart by space, not rules: the list sits inset from
// the sidebar's edges, and hover and the open thread fill a soft rounded box.
const row = cn(panelRowLine, "relative outline-none");

/**
 * What leads a row: in Active, which spans projects, its project's mark; inside its project,
 * room the width of the project's folder glyph, so its title lines up with the project's name;
 * else nothing.
 */
export type RowLead = "project" | "indent" | "none";

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
 * A thread in the sidebar: one line, its title and at most one small mark at the right edge
 * (`RowIndicator`). The rest (status in words, branch, pull request, provider, machine) is in
 * the thread itself, the row's spoken name and its hover card. Under the pointer or keyboard
 * focus the row's actions take the mark's place.
 */
export function ThreadRow(props: {
  threadId: string;
  settled: boolean;
  leaving?: boolean | undefined;
  machine?: RowMachine | undefined;
  /** The list's id for the row, when it isn't the thread's own (another machine's thread). */
  rowId?: string | undefined;
  lead: RowLead;
  /** The hover actions, when not a task's own (a chat's: `ChatRowActions`). */
  actions?: ComponentType<RowActionsProps> | undefined;
  /** At rest: the title in subtle ink (full ink while open), as a settled row's. */
  dimmed?: boolean | undefined;
}) {
  const { machine } = props;
  const Actions = props.actions ?? RowActions;
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
  const body = (
    <>
      {props.lead === "project" && <ProjectMark id={entry.workspaceId} badge={card.badge} />}
      {props.lead === "indent" && <span aria-hidden className="w-4 shrink-0" />}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          current
            ? "font-medium text-foreground"
            : props.dimmed
              ? "text-subtle-foreground"
              : "text-foreground",
          // Under the pointer or keyboard focus the row's actions take the mark's place: the
          // title stops short of them. An action's menu keeps them up after the pointer leaves.
          actions ? "pr-28" : "group-has-[[data-popup-open]]/row:pr-28",
        )}
      >
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
      </span>
      {!actions && !renaming && (
        <span className="flex shrink-0 items-center group-has-[[data-popup-open]]/row:hidden">
          <RowIndicator attention={attention} />
        </span>
      )}
    </>
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
            {renaming ? (
              <div className={row}>{body}</div>
            ) : (
              <Link
                {...threadOn(machine?.id, entry.id)}
                aria-label={`${card.title}${card.announceUnread ? ", unread" : ""}${selected ? ", selected" : ""}. ${details.join(", ")}`}
                data-row-focus=""
                draggable={false}
                className={cn(
                  row,
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
              <Actions
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
