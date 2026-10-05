import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { RowFoot, RowHead, RowTitle, threadDetails } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useThreadCard } from "./use-thread-card.ts";

const card =
  "flex w-full flex-col gap-[3px] rounded-lg px-2.5 pt-[7px] pb-2 text-left outline-none transition-colors duration-(--dur-1)";

/**
 * One Home task: its project and status, its title, then where the work happens and what it
 * changed. A thread that needs you carries a warm tint; the open one a filled background.
 * Settle and Snooze appear on hover; right-click opens the full menu.
 */
export function ThreadRow(props: { threadId: string }) {
  const row = useThreadCard(props.threadId, false);
  const [renaming, setRenaming] = useState(false);
  if (!row) return null;
  const { entry, card: view } = row;
  const needsYou = view.status.tone === "needs-you";
  const body = (title: ReactNode) => (
    <>
      <span aria-hidden className="contents">
        <RowHead card={view} />
      </span>
      <RowTitle card={view}>
        {title}
        {view.announceUnread && <span className="sr-only">, unread</span>}
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
              <RenameField entry={entry} title={view.title} onDone={() => setRenaming(false)} />,
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
                  ? "bg-[color-mix(in_oklab,var(--status-needs-you)_5%,transparent)] group-hover/row:bg-[color-mix(in_oklab,var(--status-needs-you)_9%,transparent)]"
                  : "group-hover/row:bg-sidebar-accent focus-visible:bg-sidebar-accent",
                "data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
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
            snoozed={view.flags.snoozed}
            className="top-[5px] right-1.5"
          />
        )}
      </div>
    </ThreadMenu>
  );
}
