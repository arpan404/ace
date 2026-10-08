import { DotsSixVerticalIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useRefusedTitle, useSelected } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import {
  ProjectMark,
  RowDetail,
  RowMeta,
  detailLine,
  threadDetails,
  titleTone,
} from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useThreadCard } from "./use-thread-card.ts";

const row =
  "flex min-h-8 w-full flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left text-ui outline-none transition-colors duration-(--dur-1)";

/**
 * One thread in the Home list, on one line: the project's two letters, the title, and at the
 * end its marks (a snooze, the pull request, the status as a dot or spinner, the time). A working
 * thread adds a quiet second line with its branch, changes and provider. No card, no border: the
 * open row has a soft fill, a picked one (for a bulk action) a tint of the focus colour, and a
 * settled one is dimmed. Quick actions take the marks' place on hover; right-click opens the
 * full menu. On a touch screen a pinned row carries a drag handle: a finger on the row scrolls
 * the list, a finger on the handle moves the row (the list owns both).
 */
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
  const detail = !settled && detailLine(card);
  const details = threadDetails(card);
  return (
    <ThreadMenu entry={entry} state={card.flags} onRename={() => setRenaming(true)}>
      <div
        className="group/row relative"
        // Settled rows stay out of picking and dragging, as they always have.
        {...(settled ? {} : { "data-thread-row": entry.id })}
      >
        {renaming ? (
          <div className={cn(row, "flex-row items-center gap-2 bg-sidebar-accent")}>
            <ProjectMark badge={card.badge} />
            <RenameField
              entry={entry}
              title={refused ?? card.title}
              onDone={() => setRenaming(false)}
            />
          </div>
        ) : (
          <Tip label={details.join(" · ")} side="right">
            <Link
              to="/t/$threadId"
              params={{ threadId: entry.id }}
              data-row-focus=""
              className={cn(
                row,
                "group/link focus-ring-inset group-hover/row:bg-sidebar-accent focus-visible:bg-sidebar-accent data-[status=active]:bg-foreground/8",
                selected && "bg-ring/10",
                handle && "pointer-coarse:pr-11",
              )}
            >
              <span className="flex h-5 items-center gap-2">
                <ProjectMark badge={card.badge} />
                {/* The actions cover the title's end on hover: fade it rather than cut a letter. */}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate group-focus-within/row:fade-under-actions group-hover/row:fade-under-actions group-data-[status=active]/link:text-foreground",
                    settled ? "[--under:1.25rem]" : "[--under:2.75rem]",
                    titleTone(card),
                  )}
                >
                  {card.title}
                  {card.announceUnread && <span className="sr-only">, unread</span>}
                  {selected && <span className="sr-only">, selected</span>}
                  <span className="sr-only">. {details.join(", ")}</span>
                </span>
                <span aria-hidden className="contents">
                  <RowMeta card={card} detail={detail} />
                </span>
              </span>
              {detail && (
                <span aria-hidden className="contents">
                  <RowDetail card={card} />
                </span>
              )}
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
        {!renaming && (
          <RowActions
            entry={entry}
            settled={settled}
            pinned={card.flags.pinned}
            snoozed={card.flags.snoozed}
          />
        )}
      </div>
    </ThreadMenu>
  );
}
