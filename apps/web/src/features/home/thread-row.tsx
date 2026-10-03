import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { CardLines, CardTitle } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useThreadCard } from "./use-thread-card.ts";

const grid =
  "grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 rounded-md px-[11px] pt-[9px] pb-2.5 outline-none transition-colors duration-(--dur-1) compact:pt-1.5 compact:pb-[7px]";
/** The keyboard ring of the row's link, drawn over the hover actions so none of it hides. */
const ring =
  "after:pointer-events-none after:absolute after:inset-0 after:z-[2] after:rounded-md has-[>a:focus-visible]:after:shadow-[inset_0_0_0_2px_var(--ring)]";

/**
 * One Home card: project and machine on line one with the age, the title on line two (medium
 * when it needs you, is unread or open), branch and PR on line three with the status mark and
 * provider. Settle and Snooze appear on hover; right-click opens the full menu.
 */
export function ThreadRow(props: { threadId: string }) {
  const row = useThreadCard(props.threadId, false);
  const [renaming, setRenaming] = useState(false);
  if (!row) return null;
  const { entry, card } = row;
  const lines = (
    <CardLines
      card={card}
      title={
        renaming ? (
          <RenameField entry={entry} title={card.title} onDone={() => setRenaming(false)} />
        ) : (
          <CardTitle card={card} />
        )
      }
    />
  );
  return (
    <ThreadMenu entry={entry} state={card.flags} onRename={() => setRenaming(true)}>
      <div className={cn("group/row relative", ring)} data-thread-row={entry.id}>
        {renaming ? (
          <div className={cn(grid, "bg-sidebar-accent")}>{lines}</div>
        ) : (
          <Link
            to="/t/$threadId"
            params={{ threadId: entry.id }}
            className={cn(
              grid,
              "group/link group-hover/row:bg-sidebar-accent focus-visible:bg-sidebar-accent",
              "data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
            )}
          >
            {lines}
          </Link>
        )}
        {!renaming && <RowActions entry={entry} settled={false} snoozed={card.flags.snoozed} />}
      </div>
    </ThreadMenu>
  );
}
