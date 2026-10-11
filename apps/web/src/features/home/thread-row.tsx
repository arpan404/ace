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
import { RowStatus, StatusMark, threadDetails, titleTone, quietCard } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useThreadCard } from "./use-thread-card.ts";

const row =
  "flex w-full items-center rounded-md px-2 text-left text-ui outline-none transition-colors duration-(--dur-1)";

/** One compact title row; full context stays in its accessible name and hover card. */
export function ThreadRow(props: {
  threadId: string;
  settled: boolean;
  leaving?: boolean | undefined;
  showProject?: boolean | undefined;
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
  const attention = card.status.tone === "needs-you" || card.status.tone === "failed";
  const body = (
    <div className="flex min-w-0 w-full items-center gap-1.5 group-focus-within/row:pr-7 group-hover/row:pr-7">
      <span
        {...(card.flags.unread
          ? { role: "img", "aria-label": "Unread activity" }
          : { "aria-hidden": true })}
        className="grid w-3 shrink-0 place-items-center"
      >
        <StatusMark card={card} muted={!attention} />
      </span>
      <div
        className={cn("min-w-0 flex-1 truncate text-ui leading-4", titleTone(card, highlighted))}
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
      <RowStatus card={card} />
    </div>
  );
  return (
    <>
      {props.showProject && (
        <h3 className="flex h-7 items-center truncate px-2 text-xs font-normal text-muted-foreground">
          {card.project}
        </h3>
      )}
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
              <div className={cn(row, "h-8 pointer-coarse:h-11")}>{body}</div>
            ) : (
              <Link
                to="/t/$threadId"
                params={{ threadId: entry.id }}
                aria-label={`${card.title}${card.announceUnread ? ", unread" : ""}${selected ? ", selected" : ""}. ${details.join(", ")}`}
                data-row-focus=""
                draggable={false}
                className={cn(
                  row,
                  "h-8 pointer-coarse:h-11",
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
          <ThreadHoverContent card={card} entry={entry} icon={data.icon} instance={instance} />
        )}
      </HoverCard>
    </>
  );
}
