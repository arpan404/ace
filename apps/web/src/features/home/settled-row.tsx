import { Link, useLocation } from "@tanstack/react-router";
import {
  settleAction,
  useHomeSelection,
  useRefusedTitle,
  useRenameTitle,
  useThreadActions,
} from "@/features/organize/index.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { GitMergeIcon, GitPullRequestIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { RenameField } from "./rename-field.tsx";
import { RowMoreMenu } from "./row-actions.tsx";
import { ProjectMark, threadDetails } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useThreadCard } from "./use-thread-card.ts";

// The task rows' box and fills, one line tall: settled work is out of the way.
const row =
  "flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-ui transition-colors duration-(--motion-fast)";

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
      {/* Settled work recedes as a whole: a grey badge and a grey title, full colour only while open. */}
      <ProjectMark id={entry.workspaceId} badge={card.badge} quiet={!current} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate leading-5",
          current ? "text-foreground" : "text-subtle-foreground/75",
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
      </span>
      {!renaming && (
        // What the work left behind, then its age: the PR when there is one, else the lines
        // changed. Faint like the rest of the row; the row's actions take this place on hover.
        <span className="flex shrink-0 items-center gap-2.5 text-meta text-faint-foreground tabular-nums group-hover/row:invisible group-focus-within/row:invisible">
          {card.pr !== undefined ? (
            <span className="inline-flex items-center gap-1">
              {card.prState === "merged" ? (
                <GitMergeIcon aria-hidden size={12} />
              ) : (
                <GitPullRequestIcon aria-hidden size={12} />
              )}
              {card.pr}
            </span>
          ) : card.diff && card.diff.added + card.diff.removed > 0 ? (
            <span>
              +{card.diff.added} −{card.diff.removed}
            </span>
          ) : null}
          <span>{card.age}</span>
        </span>
      )}
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
              current ? "bg-active" : "hover:bg-hover",
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
