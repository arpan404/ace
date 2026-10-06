import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useRefusedTitle, useSelected } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { RowFoot, RowHead, RowTitle, threadDetails } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useThreadCard } from "./use-thread-card.ts";

const card =
  "flex w-full flex-col gap-[3px] rounded-lg px-2.5 pt-[7px] pb-2 text-left outline-none transition-colors duration-(--dur-1)";

/**
 * One Home task: its project and status, its title, then where the work happens and what it
 * changed. A thread that needs you carries a warm tint; the open one a filled background.
 * Pin, Settle and Snooze appear on hover; right-click opens the full menu. A picked row (for a
 * bulk action) wears the focus colour.
 */
export function ThreadRow(props: { threadId: string }) {
  const row = useThreadCard(props.threadId, false);
  const [editing, setRenaming] = useState(false);
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing || refused !== undefined;
  const started = useStartedTitle(props.threadId);
  const selected = useSelected(props.threadId);
  if (!row) return null;
  const { entry } = row;
  // A thread this window started reads its provisional title until the daemon titles it.
  const view =
    started && row.card.title === "New thread" ? { ...row.card, title: started } : row.card;
  const needsYou = view.status.tone === "needs-you";
  const body = (title: ReactNode) => (
    <>
      <span aria-hidden className="contents">
        <RowHead card={view} />
      </span>
      <RowTitle card={view}>
        {title}
        {view.announceUnread && <span className="sr-only">, unread</span>}
        {selected && <span className="sr-only">, selected</span>}
        <span className="sr-only">. {threadDetails(view).join(", ")}</span>
      </RowTitle>
      <span aria-hidden className="contents">
        <RowFoot card={view} />
      </span>
    </>
  );
  return (
    <ThreadMenu entry={entry} state={view.flags} onRename={() => setRenaming(true)}>
      <div className="group/row relative" data-thread-row={entry.id}>
        {renaming ? (
          <div className={cn(card, "bg-sidebar-accent")}>
            {body(
              <RenameField
                entry={entry}
                title={refused ?? view.title}
                onDone={() => setRenaming(false)}
              />,
            )}
          </div>
        ) : (
          // The marks give way to Settle and Snooze; the tooltip still says what they meant.
          <Tip label={threadDetails(view).join(" · ")} side="right">
            <Link
              to="/t/$threadId"
              params={{ threadId: entry.id }}
              data-row-focus=""
              className={cn(
                card,
                "group/link focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]",
                needsYou
                  ? "bg-status-needs-you/5 group-hover/row:bg-status-needs-you/9"
                  : "group-hover/row:bg-sidebar-accent focus-visible:bg-sidebar-accent",
                "data-[status=active]:bg-foreground/8",
                selected && "bg-ring/10 shadow-[inset_0_0_0_1px_var(--ring)]",
              )}
            >
              {body(view.title)}
            </Link>
          </Tip>
        )}
        {!renaming && (
          <RowActions
            entry={entry}
            settled={false}
            pinned={view.flags.pinned}
            snoozed={view.flags.snoozed}
            className="top-[5px] right-1.5"
          />
        )}
      </div>
    </ThreadMenu>
  );
}
