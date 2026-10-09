import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { useRefusedTitle, useSelected } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { Dot } from "@/components/ui/dot.tsx";
import { HoverCard, HoverCardTrigger } from "@/components/ui/hover-card.tsx";
import { ThreadHoverContent, useThreadHover } from "./thread-hover-card.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import {
  ProjectMark,
  RowDetail,
  RowMeta,
  RowIdentity,
  RowIdentitySpace,
  RowStatus,
  threadDetails,
  titleTone,
  quietCard,
} from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useThreadCard } from "./use-thread-card.ts";

const row =
  "flex w-full items-center rounded-md px-2 text-left text-ui outline-none transition-colors duration-(--dur-1)";

/** Tasks show project and status, title, then context; settled work stays compact. */
export function ThreadRow(props: {
  threadId: string;
  settled: boolean;
  leaving?: boolean | undefined;
}) {
  const { settled } = props;
  const data = useThreadCard(props.threadId, settled, props.leaving);
  const [editing, setRenaming] = useState(false);
  const hover = useThreadHover();
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing || refused !== undefined;
  const started = useStartedTitle(props.threadId);
  const selected = useSelected(props.threadId);
  const current = useLocation({
    select: (location) => location.pathname === `/t/${props.threadId}`,
  });
  const highlighted = selected || current;
  if (!data) return null;
  const { entry } = data;
  // A thread this window started reads its provisional title until the daemon titles it.
  const card =
    started && data.card.title === "New thread" ? { ...data.card, title: started } : data.card;
  const handle = card.flags.pinned && !renaming;
  const details = threadDetails(card);
  const quiet = quietCard(card);
  const instance =
    (entry.switch?.state === "queued" ? entry.switch.selection.instanceId : undefined) ??
    entry.live?.account ??
    entry.execution?.instanceId;
  return (
    <HoverCard open={hover.open && !renaming} onOpenChange={hover.change}>
      <ThreadMenu entry={entry} state={card.flags} onRename={() => setRenaming(true)}>
        <HoverCardTrigger
          delay={180}
          closeDelay={100}
          onClick={() => hover.change(false)}
          onContextMenu={() => hover.change(false)}
          render={<div />}
          className="group/row relative"
          data-attention={quiet ? "quiet" : "attention"}
          // Settled rows stay out of picking and dragging, as they always have.
          {...(settled ? {} : { "data-thread-row": entry.id })}
        >
          {renaming ? (
            <div
              className={cn(
                row,
                settled ? "h-8" : "h-20 py-2.5 compact:h-18 compact:py-2",
                "flex-row items-center gap-2 bg-sidebar-accent",
              )}
            >
              <ProjectMark badge={card.badge} icon={data.icon} quiet={quiet} />
              <RenameField
                entry={entry}
                title={refused ?? card.title}
                onDone={() => setRenaming(false)}
              />
            </div>
          ) : (
            <Link
              to="/t/$threadId"
              params={{ threadId: entry.id }}
              aria-label={`${card.title}${card.announceUnread ? ", unread" : ""}${selected ? ", selected" : ""}. ${details.join(", ")}`}
              data-row-focus=""
              draggable={false}
              className={cn(
                row,
                settled ? "h-8" : "h-20 py-2.5 compact:h-18 compact:py-2",
                "group/link focus-ring focus-visible:bg-sidebar-accent data-[status=active]:bg-foreground/5",
                selected && "bg-foreground/5",
                handle && "pointer-coarse:pr-11",
              )}
            >
              <span
                className={cn(
                  "flex min-w-0 w-full",
                  settled ? "items-center gap-2" : "flex-col gap-1 compact:gap-0.5",
                )}
              >
                {settled ? (
                  <ProjectMark badge={card.badge} icon={data.icon} quiet={quiet} />
                ) : (
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 text-xs leading-4",
                      quiet ? "text-subtle-foreground" : "text-muted-foreground",
                    )}
                  >
                    <ProjectMark badge={card.badge} icon={data.icon} quiet={quiet} />
                    <span className="min-w-0 flex-1 truncate group-focus-within/row:pr-24 group-hover/row:pr-24">
                      {card.project}
                    </span>
                    <span className="contents group-focus-within/row:hidden group-hover/row:hidden group-has-[[data-popup-open]]/row:hidden">
                      <RowStatus card={card} />
                    </span>
                  </span>
                )}
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {!settled && card.flags.unread && <Dot tone="working" label="Unread activity" />}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      settled
                        ? "text-ui leading-4 group-focus-within/row:pr-24 group-hover/row:pr-24"
                        : "text-ui leading-5",
                      titleTone(card, highlighted),
                    )}
                  >
                    {card.title}
                  </span>
                </span>
                {settled ? (
                  <>
                    <span aria-hidden className="contents">
                      <RowMeta card={card} />
                    </span>
                    <RowIdentitySpace card={card} machinePrimary={data.machinePrimary} />
                  </>
                ) : (
                  <RowDetail card={card} machinePrimary={data.machinePrimary} />
                )}
              </span>
            </Link>
          )}
          {!renaming && (
            <RowIdentity
              card={card}
              instance={instance}
              machinePrimary={data.machinePrimary}
              className={cn(
                "absolute right-2",
                settled ? "top-1/2 -translate-y-1/2" : "bottom-[11px] compact:bottom-[9px]",
                handle && "pointer-coarse:right-12",
              )}
            />
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
              entry={entry}
              settled={settled}
              snoozed={card.flags.snoozed}
              machinePrimary={data.machinePrimary}
            />
          )}
        </HoverCardTrigger>
      </ThreadMenu>
      {hover.open && !renaming && (
        <ThreadHoverContent card={card} entry={entry} icon={data.icon} instance={instance} />
      )}
    </HoverCard>
  );
}
