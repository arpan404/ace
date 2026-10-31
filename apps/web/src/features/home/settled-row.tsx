import { Link } from "@tanstack/react-router";

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
import { threadDetails } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useOpenHere, type RowMachine } from "./thread-row.tsx";
import { threadOn } from "@/lib/machine-routes.ts";
import { useThreadCard } from "./use-thread-card.ts";

// The task rows' one line, box and fills: settled work is out of the way.
const box =
  "flex h-(--row-height) w-full items-center gap-2.5 rounded-md px-2.5 text-left text-md transition-colors duration-(--motion-fast)";

interface SettledProps {
  threadId: string;
  leaving?: boolean | undefined;
  /** Another machine's settled thread acts on that machine, under its list `rowId`. */
  machine?: RowMachine | undefined;
  rowId?: string | undefined;
}

/**
 * A thread its project settled within the grace period: one line in its project, dimmed (the
 * title in subtle ink, full ink only while open), lined up with the project's name. Under the
 * pointer or focus, Unsettle and the row's ⋯ menu take the right end; the context menu is the
 * task row's own.
 */
export function RecentlySettledRow(props: SettledProps) {
  const { machine } = props;
  const rowId = props.rowId ?? props.threadId;
  const data = useThreadCard(props.threadId, true, props.leaving);
  const selection = useHomeSelection();
  const actions = useThreadActions();
  const editing = useRenameTitle(rowId);
  const refused = useRefusedTitle(props.threadId);
  const renaming = editing !== undefined || refused !== undefined;
  const current = useOpenHere(props.threadId, machine?.id);
  if (!data) return null;
  const { entry } = data;
  const card = machine
    ? { ...data.card, machine: machine.name, machineIcon: machine.icon }
    : data.card;
  const rename = () => selection.rename(rowId, card.title);
  const unsettle = settleAction(entry, card.flags, actions);
  const title = renaming ? (
    <RenameField
      entry={entry}
      rowId={rowId}
      title={editing ?? refused ?? card.title}
      onDone={() => selection.finishRename()}
    />
  ) : (
    card.title
  );
  const body = (
    <>
      <span aria-hidden className="w-4 shrink-0" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          current ? "font-medium text-foreground" : "text-subtle-foreground",
        )}
      >
        {title}
      </span>
    </>
  );
  return (
    <ThreadMenu entry={entry} rowId={rowId} state={card.flags} onRename={rename}>
      <div className="group/row relative">
        {renaming ? (
          <div className={box}>{body}</div>
        ) : (
          <Link
            {...threadOn(machine?.id, entry.id)}
            aria-label={`${card.title}. ${["Settled", ...threadDetails(card)].join(", ")}`}
            data-row-focus=""
            draggable={false}
            className={cn(
              box,
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
            role="presentation"
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
