import type { RowAttention, ThreadCard } from "@ace/ui-core";
import type { ReactNode } from "react";
import { PushPinIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import {
  BrowsingMark,
  ComputerUseMark,
  ProjectMark,
  RowContext,
  RowStatus,
  titleTone,
} from "./row-parts.tsx";

/**
 * An Active row's height: three lines of 16, 20 and 16px, 4px between each, 10px above and below.
 * The row keeps the panel row's corners and side padding.
 */
export const taskRowHeight = "h-[80px] py-2.5 px-3 items-start";

/**
 * An Active row's three lines: the project and the status (or its age), the title, then the
 * branch, pull request, machine and provider. The status stays while the row's actions show:
 * they sit beside it, and the project name stops short of both.
 */
export function TaskLines(props: {
  card: ThreadCard;
  attention: RowAttention;
  workspaceId: string;
  /** The row's actions are up (pointer, focus, or one of their menus open). */
  actions: boolean;
  /** The title, or the rename field in its place. */
  title: ReactNode;
  /** A settled row: its title drops to the muted ink. */
  dimmed?: boolean | undefined;
}) {
  const { card, attention } = props;
  return (
    <div className="flex w-full min-w-0 flex-col">
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-meta leading-4 text-muted-foreground",
          props.actions ? "pr-28" : "group-has-[[data-popup-open]]/row:pr-28",
        )}
      >
        <ProjectMark id={props.workspaceId} badge={card.badge} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate">{card.project}</span>
          {card.flags.pinned && (
            <PushPinIcon aria-hidden size={11} className="shrink-0 text-subtle-foreground" />
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <BrowsingMark threadId={card.id} />
          <ComputerUseMark threadId={card.id} />
          <RowStatus card={card} attention={attention} />
        </span>
      </div>
      <div
        className={cn(
          "mt-1 min-w-0 truncate text-md leading-5",
          props.dimmed ? "font-medium text-muted-foreground" : titleTone(attention),
        )}
      >
        {props.title}
      </div>
      <div className="mt-1">
        <RowContext card={card} />
      </div>
    </div>
  );
}
