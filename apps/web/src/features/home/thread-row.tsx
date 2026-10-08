import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useRefusedTitle, useSelected } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { StatusLabel } from "@/components/status-label.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import {
  ProjectMark,
  RowDetail,
  RowMeta,
  threadDetails,
  titleTone,
  StatusMark,
} from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useThreadCard } from "./use-thread-card.ts";

const row =
  "flex w-full items-center rounded-md px-2 text-left text-ui outline-none transition-colors duration-(--dur-1)";

/** Tasks keep their context on a second line; settled work stays compact. */
export function ThreadRow(props: { threadId: string; settled: boolean }) {
  const { settled } = props;
  const data = useThreadCard(props.threadId, settled);
  const [editing, setRenaming] = useState(false);
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing || refused !== undefined;
  const started = useStartedTitle(props.threadId);
  const selected = useSelected(props.threadId);
  if (!data) return null;
  const { entry } = data;
  // A thread this window started reads its provisional title until the daemon titles it.
  const card =
    started && data.card.title === "New thread" ? { ...data.card, title: started } : data.card;
  const handle = card.flags.pinned && !renaming;
  const details = threadDetails(card);
  return (
    <ThreadMenu entry={entry} state={card.flags} onRename={() => setRenaming(true)}>
      <div
        className="group/row relative"
        // Settled rows stay out of picking and dragging, as they always have.
        {...(settled ? {} : { "data-thread-row": entry.id })}
      >
        {renaming ? (
          <div
            className={cn(
              row,
              settled ? "h-8" : "h-[46px]",
              "flex-row items-center gap-2 bg-sidebar-accent",
            )}
          >
            <ProjectMark badge={card.badge} />
            <RenameField
              entry={entry}
              title={refused ?? card.title}
              onDone={() => setRenaming(false)}
            />
          </div>
        ) : (
          <Tip
            label={
              <span>
                {card.title} ·{" "}
                <StatusLabel
                  tone={card.status.tone}
                  label={card.status.label}
                  mark={<StatusMark card={card} />}
                />{" "}
                · {details.slice(1).join(" · ")}
              </span>
            }
            side="right"
          >
            <Link
              to="/t/$threadId"
              params={{ threadId: entry.id }}
              aria-label={`${card.title}${card.announceUnread ? ", unread" : ""}${selected ? ", selected" : ""}. ${details.join(", ")}`}
              data-row-focus=""
              draggable={false}
              className={cn(
                row,
                settled ? "h-8" : "h-[46px]",
                "group/link focus-visible:shadow-[inset_0_0_0_1px_var(--sidebar-border)] group-hover/row:bg-sidebar-accent focus-visible:bg-sidebar-accent data-[status=active]:bg-foreground/8",
                selected && "bg-foreground/8",
                handle && "pointer-coarse:pr-11",
              )}
            >
              <span
                className={cn(
                  "flex min-w-0 w-full",
                  settled ? "items-center gap-2" : "flex-col gap-0.5",
                )}
              >
                {settled && <ProjectMark badge={card.badge} />}
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className={cn("min-w-0 flex-1 truncate leading-4", titleTone(card))}>
                    {card.title}
                  </span>
                  {!settled && (
                    <span aria-hidden>
                      <StatusMark card={card} />
                    </span>
                  )}
                </span>
                {settled ? (
                  <span aria-hidden className="contents">
                    <RowMeta card={card} />
                  </span>
                ) : (
                  <RowDetail card={card} />
                )}
              </span>
            </Link>
          </Tip>
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
        {!renaming && <RowActions entry={entry} settled={settled} />}
      </div>
    </ThreadMenu>
  );
}
