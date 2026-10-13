import { Link, useLocation } from "@tanstack/react-router";
import {
  settleAction,
  useHomeSelection,
  useRefusedTitle,
  useRenameTitle,
  useThreadActions,
} from "@/features/organize/index.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import { RenameField } from "./rename-field.tsx";
import { RowMoreMenu } from "./row-actions.tsx";
import { ProjectMark, threadDetails, titleTone } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useThreadCard } from "./use-thread-card.ts";

// The task rows' box and fills, one line tall: settled work is out of the way.
const row =
  "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-ui transition-colors duration-(--motion-fast)";

/**
 * A settled thread at rest: its project badge and title on one line. Under the pointer or focus,
 * Unsettle and the row's ⋯ menu take the right end; the context menu is the task row's own.
 */
export function SettledRow(props: { threadId: string; leaving?: boolean | undefined }) {
  const data = useThreadCard(props.threadId, true, props.leaving);
  const selection = useHomeSelection();
  const actions = useThreadActions();
  const editing = useRenameTitle(props.threadId);
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing !== undefined || refused !== undefined;
  const current = useLocation({
    select: (location) =>
      location.pathname === `/t/${props.threadId}` ||
      location.pathname.startsWith(`/t/${props.threadId}/agents/`),
  });
  if (!data) return null;
  const { entry, card } = data;
  const rename = () => selection.rename(props.threadId, card.title);
  const unsettle = settleAction(entry, card.flags, actions);
  const body = (
    <>
      <ProjectMark id={entry.workspaceId} badge={card.badge} />
      <span className={cn("min-w-0 flex-1 truncate leading-5", titleTone(card))}>
        {renaming ? (
          <RenameField
            entry={entry}
            title={editing ?? refused ?? card.title}
            onDone={() => selection.finishRename()}
          />
        ) : (
          card.title
        )}
      </span>
    </>
  );
  return (
    <ThreadMenu entry={entry} state={card.flags} onRename={rename}>
      <div className="group/row relative">
        {renaming ? (
          <div className={row}>{body}</div>
        ) : (
          <Link
            to="/t/$threadId"
            params={{ threadId: entry.id }}
            aria-label={`${card.title}. ${threadDetails(card).join(", ")}`}
            data-row-focus=""
            draggable={false}
            className={cn(
              row,
              "outline-none focus-ring-inset focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover/row:pr-16 group-focus-within/row:pr-16",
              current ? "bg-foreground/8" : "hover:bg-accent",
            )}
          >
            {body}
          </Link>
        )}
        {!renaming && (
          <div
            className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex has-[[data-popup-open]]:flex"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {unsettle && (
              <IconButton
                icon={unsettle.icon}
                size="sm"
                label={`${unsettle.label} ${card.title}`}
                tip={unsettle.label}
                tabIndex={-1}
                onClick={unsettle.run}
              />
            )}
            <RowMoreMenu entry={entry} flags={card.flags} onRename={rename} />
          </div>
        )}
      </div>
    </ThreadMenu>
  );
}
