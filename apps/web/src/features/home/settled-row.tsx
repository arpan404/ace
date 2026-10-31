import { Link } from "@tanstack/react-router";
import type { ThreadListEntry } from "@ace/protocol";
import type { ThreadCard } from "@ace/ui-core";
import type { ComponentType, ReactNode } from "react";
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
import { MiddleTruncate } from "@/components/ui/middle-truncate.tsx";
import { ProjectMark, threadDetails } from "./row-parts.tsx";
import { ThreadMenu } from "./thread-menu.tsx";
import { useOpenHere, type RowMachine } from "./thread-row.tsx";
import { threadOn } from "@/lib/machine-routes.ts";
import { useThreadCard } from "./use-thread-card.ts";

// The task rows' box and fills: settled work is out of the way.
const box =
  "flex w-full rounded-md px-2.5 text-left text-ui transition-colors duration-(--motion-fast)";
const oneLine = "h-[30px] items-center gap-2";
const twoLines = "h-[52px] flex-col justify-center gap-0.5 py-[7px]";

interface SettledProps {
  threadId: string;
  leaving?: boolean | undefined;
  /** Another machine's settled thread acts on that machine, under its list `rowId`. */
  machine?: RowMachine | undefined;
  rowId?: string | undefined;
}

interface Drawn {
  entry: ThreadListEntry;
  card: ThreadCard;
  current: boolean;
  /** The title, or the rename field while it is renamed. */
  title: ReactNode;
  renaming: boolean;
}

/** What the work left behind: the PR when there is one, else the lines added. */
function LeftBehind(props: { card: ThreadCard }) {
  const { card } = props;
  if (card.pr !== undefined)
    return (
      <span className="inline-flex items-center gap-1">
        {card.prState === "merged" ? (
          <GitMergeIcon aria-hidden size={12} />
        ) : (
          <GitPullRequestIcon aria-hidden size={12} />
        )}
        #{card.pr}
      </span>
    );
  return card.diff && card.diff.added > 0 ? <span>+{card.diff.added}</span> : null;
}

/**
 * A settled thread's link, its hover actions (Unsettle and ⋯) and the task row's context menu.
 * `Body` draws what the link shows.
 */
function SettledShell(
  props: SettledProps & {
    lines: string;
    Body: ComponentType<Drawn>;
    /** Said first after the title, where the row shows a word its details don't carry. */
    said?: string | undefined;
  },
) {
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
  const { Body } = props;
  const body = (
    <Body entry={entry} card={card} current={current} title={title} renaming={renaming} />
  );
  return (
    <ThreadMenu entry={entry} rowId={rowId} state={card.flags} onRename={rename}>
      <div className="group/row relative">
        {renaming ? (
          <div className={cn(box, props.lines)}>{body}</div>
        ) : (
          <Link
            {...threadOn(machine?.id, entry.id)}
            aria-label={`${card.title}. ${[props.said, ...threadDetails(card)].filter(Boolean).join(", ")}`}
            data-row-focus=""
            draggable={false}
            className={cn(
              box,
              props.lines,
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

const faint =
  "flex shrink-0 items-center gap-2.5 text-meta text-faint-foreground tabular-nums group-hover/row:invisible group-focus-within/row:invisible";

function OneLineBody({ entry, card, current, title, renaming }: Drawn) {
  return (
    <>
      {/* Settled work recedes as a whole: a grey badge and title, full colour only while open. */}
      <ProjectMark id={entry.workspaceId} badge={card.badge} quiet={!current} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate leading-5",
          current ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {title}
      </span>
      {!renaming && (
        <span className={faint}>
          <LeftBehind card={card} />
          <span>{card.age}</span>
        </span>
      )}
    </>
  );
}

/**
 * A settled thread on one line, among search matches: its project badge, title, pull request
 * or lines added, and age. Under the pointer or focus, Unsettle and the row's ⋯ menu take the
 * right end; the context menu is the task row's own.
 */
export function SettledRow(props: SettledProps) {
  return <SettledShell {...props} lines={oneLine} Body={OneLineBody} />;
}

function TwoLineBody({ card, current, title, renaming }: Drawn) {
  const left = card.pr !== undefined || (card.diff?.added ?? 0) > 0;
  return (
    <>
      <span className="flex w-full min-w-0 items-center gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-md leading-5 font-medium",
            current ? "text-foreground" : "text-subtle-foreground",
          )}
        >
          {title}
        </span>
        {!renaming && (
          <span className={faint}>
            <span className="inline-flex items-center gap-1.5">
              <LeftBehind card={card} />
              {left && <span aria-hidden>·</span>}
              <span>{card.age}</span>
            </span>
          </span>
        )}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-meta leading-4 text-faint-foreground">
        {card.branch && (
          <>
            <MiddleTruncate text={card.branch.name} className="min-w-0 font-mono" />
            <span aria-hidden>·</span>
          </>
        )}
        <span className="shrink-0">Settled</span>
      </span>
    </>
  );
}

/**
 * A thread its project settled within the grace period: a task row's two lines, dimmed. Line 1
 * is the title, then the PR (or lines added) and age; line 2 its branch and the word Settled.
 */
export function RecentlySettledRow(props: SettledProps) {
  return <SettledShell {...props} lines={twoLines} Body={TwoLineBody} said="Settled" />;
}
