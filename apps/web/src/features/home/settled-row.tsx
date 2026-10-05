import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useRefusedTitle } from "@/features/organize/index.ts";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { SettledLine } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useThreadCard } from "./use-thread-card.ts";

const row =
  "flex h-[30px] w-full items-center gap-2 rounded-md px-[11px] text-sm text-subtle-foreground outline-none transition-colors duration-(--dur-1) focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]";

/** A compact settled row: title and age, Unsettle on hover. Opening it keeps it settled. */
export function SettledRow(props: { threadId: string }) {
  const data = useThreadCard(props.threadId, true);
  const [editing, setRenaming] = useState(false);
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing || refused !== undefined;
  if (!data) return null;
  const { entry, card } = data;
  return (
    <ThreadMenu entry={entry} state={card.flags} onRename={() => setRenaming(true)}>
      <div className="group/row relative">
        {renaming ? (
          <div className={`${row} bg-sidebar-accent`}>
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
            data-row-focus=""
            className={`${row} group-hover/row:bg-sidebar-accent group-hover/row:text-muted-foreground focus-visible:bg-sidebar-accent data-[status=active]:bg-foreground/8 data-[status=active]:text-foreground`}
          >
            <SettledLine card={card} />
          </Link>
        )}
        {!renaming && (
          <RowActions
            entry={entry}
            settled
            snoozed={card.flags.snoozed}
            className="top-[3px] right-1.5"
          />
        )}
      </div>
    </ThreadMenu>
  );
}
