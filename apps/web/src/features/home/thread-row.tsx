import { PushPinIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useRefusedTitle } from "@/features/organize/index.ts";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { RenameField } from "./rename-field.tsx";
import { RowActions } from "./row-actions.tsx";
import { ThreadLine, threadDetails } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useStartedTitle } from "./started-titles.ts";
import { useThreadCard } from "./use-thread-card.ts";

const line =
  "flex h-[30px] w-full items-center gap-2 rounded-md pr-2 text-base outline-none transition-colors duration-(--dur-1)";

/**
 * One Home thread on one line: under its project's folder (indented to the folder's name), or
 * in Pinned with a pin. Settle and Snooze appear on hover; right-click opens the full menu.
 */
export function ThreadRow(props: { threadId: string; pinned?: boolean }) {
  const row = useThreadCard(props.threadId, false);
  const [editing, setRenaming] = useState(false);
  // A rename the daemon refused opens the field again, with what was typed.
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing || refused !== undefined;
  const started = useStartedTitle(props.threadId);
  if (!row) return null;
  const { entry } = row;
  // A thread this window started reads its provisional title until the daemon titles it.
  const card =
    started && row.card.title === "New thread" ? { ...row.card, title: started } : row.card;
  const indent = props.pinned ? "pl-[11px]" : "pl-9";
  const content = (
    <>
      {props.pinned && (
        <Icon icon={PushPinIcon} size={16} label="Pinned" className="text-subtle-foreground" />
      )}
      <ThreadLine
        card={card}
        title={
          renaming ? (
            <RenameField
              entry={entry}
              title={refused ?? card.title}
              onDone={() => setRenaming(false)}
            />
          ) : (
            card.title
          )
        }
      />
    </>
  );
  return (
    <ThreadMenu entry={entry} state={card.flags} onRename={() => setRenaming(true)}>
      <div className="group/row relative" data-thread-row={entry.id}>
        {renaming ? (
          <div className={cn(line, indent, "bg-sidebar-accent")}>{content}</div>
        ) : (
          // The marks give way to Settle and Snooze; the tooltip still says what they meant.
          <Tip label={threadDetails(card).join(" · ")} side="right">
            <Link
              to="/t/$threadId"
              params={{ threadId: entry.id }}
              className={cn(
                line,
                indent,
                "group/link group-hover/row:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]",
                "data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
              )}
            >
              {content}
            </Link>
          </Tip>
        )}
        {!renaming && (
          <RowActions
            entry={entry}
            settled={false}
            snoozed={card.flags.snoozed}
            className="top-[3px] right-1.5"
          />
        )}
      </div>
    </ThreadMenu>
  );
}
