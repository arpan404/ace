import type { RowAttention, ThreadCard } from "@ace/ui-core";
import type { ReactNode } from "react";
import { PushPinIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { ProjectMark } from "@/components/project-mark.tsx";
import { RowContext, RowStatus, titleTone } from "./row-parts.tsx";

/**
 * An Active row's height: three lines of 16, 20 and 16px, 4px between each, 10px above and below.
 * The row keeps the panel row's corners and side padding.
 */
export const taskRowHeight = "h-[80px] py-2.5 px-3 items-start";

/**
 * An Active row's three lines: the project's mark and name and the status (an icon, its time, or its
 * age), the title, then the branch, pull request, browser and computer use, another machine and
 * the provider. Under the pointer or keyboard focus the row's
 * actions take the status's place: the status hides where it sits, and the project name stops
 * short of the actions.
 */
export function TaskLines(props: {
  card: ThreadCard;
  /** The thread's project, whose mark leads line 1. */
  projectId: string;
  attention: RowAttention;
  /** The row's actions are up (pointer, focus, or one of their menus open). */
  actions: boolean;
  /** The thread runs on another machine: line 3 shows its mark. */
  remote: boolean;
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
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="mr-0.5 flex shrink-0">
            <ProjectMark id={props.projectId} badge={card.badge} />
          </span>
          <span className="min-w-0 truncate">{card.project}</span>
          {card.flags.pinned && (
            <PushPinIcon aria-hidden size={11} className="shrink-0 text-subtle-foreground" />
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            data-row-status=""
            aria-hidden={props.actions ? true : undefined}
            className={cn(
              "flex shrink-0 items-center",
              props.actions ? "invisible" : "group-has-[[data-popup-open]]/row:invisible",
            )}
          >
            <RowStatus card={card} attention={attention} />
          </span>
        </span>
      </div>
      <div
        className={cn(
          "mt-1 min-w-0 truncate text-md leading-5",
          props.dimmed ? "text-muted-foreground" : titleTone(attention),
        )}
      >
        {props.title}
      </div>
      <div className="mt-1">
        <RowContext card={card} remote={props.remote} />
      </div>
    </div>
  );
}
