import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Link, useLocation } from "@tanstack/react-router";
import { useConnectionState } from "@ace/client-react";
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
  ProjectMark,
  RowStatus,
  RowContext,
  RowTime,
  threadDetails,
  titleTone,
  quietCard,
} from "./row-parts.tsx";
import { Dot } from "@/components/ui/dot.tsx";
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
  const online = useConnectionState() === "ready";
  const data = useThreadCard(props.threadId, settled, props.leaving);
  const selection = useHomeSelection();
  const editing = useRenameTitle(props.threadId);
  const hover = useThreadHover();
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing !== undefined || refused !== undefined;
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
  // Attention remains visible even while an optimistic settlement is being reconciled.
  const compact = settled && (card.status.tone === "done" || card.status.tone === "idle");
  const height = compact ? "h-8 pointer-coarse:h-11" : "h-19 py-2.5";
  const title = (
    <div className="flex min-w-0 items-center gap-1.5">
      {card.flags.unread && <Dot tone="working" label="Unread activity" />}
      <div
        className={cn(
          "min-w-0 flex-1 truncate leading-5",
          !compact && "text-base",
          titleTone(card, highlighted),
        )}
      >
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
  const body = compact ? (
    <div className="flex min-w-0 w-full items-center gap-2 group-focus-within/row:pr-7 group-hover/row:pr-7">
      <div className="min-w-0 flex-1">{title}</div>
      <RowTime card={card} />
    </div>
  ) : (
    <div className="flex min-w-0 w-full flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5 pr-7 text-xs leading-4 text-muted-foreground">
        <ProjectMark badge={card.badge} />
        <span className="min-w-0 truncate">{card.project}</span>
        <span aria-hidden>·</span>
        <RowStatus card={card} />
      </div>
      {title}
      <RowContext card={card} />
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
            delay={600}
            closeDelay={100}
            onClick={() => hover.change(false)}
            onContextMenu={() => hover.change(false)}
            render={<div />}
            className={cn("group/row relative", !online && "opacity-60")}
            data-attention={quiet ? "quiet" : "attention"}
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
                  "group/link focus-ring focus-visible:bg-sidebar-accent data-[status=active]:bg-foreground/5",
                  selected && "bg-foreground/5",
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
