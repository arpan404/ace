import { CheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { viewRowClass } from "@/components/ui/view-row.tsx";
import { useArrival } from "@/lib/arrival.tsx";

/**
 * One Activity sidebar row: a 26px icon tile, the title (13/500) with its context under it,
 * the age at the bottom right, and optional inline actions. Read rows drop to the muted
 * grey; the selected row carries the 7% ink fill. The row is a `data-view-row` of the list's
 * roving focus (`useViewListKeys`); Shift-click or X picks it for a batch action, and a
 * right-click opens its `menu`.
 */
export function FeedRow(props: {
  /** A 16px glyph, or a spinner for running work. */
  icon: ReactNode;
  title: string;
  description: string;
  age: string;
  /** Waiting on you, or not yet read: foreground title and icon, and said aloud. */
  mark: "needs-you" | "unread" | undefined;
  selected?: boolean;
  onSelect(): void;
  actions?: ReactNode;
  /** Context-menu items: Mark read or unread, Open thread, Copy link. */
  menu?: ReactNode;
  /** Picked for a batch action. */
  picked?: boolean;
  onPick?(): void;
  /** The read-state id E and U mark, for an event or a run. */
  readId?: string;
}) {
  const arrival = useArrival();
  const button = (
    <button
      type="button"
      data-view-row=""
      data-read-id={props.readId}
      aria-current={props.selected ? "page" : undefined}
      onClick={(event) => {
        if (event.shiftKey && props.onPick) props.onPick();
        else props.onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key !== "x" || !props.onPick || event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        props.onPick();
      }}
      className={cn(
        viewRowClass,
        "pt-[9px] pr-12 pb-2 hover:bg-transparent aria-[current=page]:bg-transparent",
      )}
    >
      <span
        data-tone={!props.picked && props.mark === "needs-you" ? "needs-you" : undefined}
        className={cn(
          "mt-px grid size-[26px] place-items-center rounded-sm",
          props.picked
            ? "bg-primary text-primary-foreground"
            : props.mark === "needs-you"
              ? "bg-(--tone)/13 text-(--tone)"
              : "bg-secondary",
          !props.picked && props.mark === "unread" && "text-foreground",
          !props.picked && !props.mark && "text-muted-foreground",
        )}
      >
        {props.picked ? <Icon icon={CheckIcon} size={14} /> : props.icon}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-ui leading-[1.3]",
            props.mark ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {props.title}
        </span>
        {props.mark && (
          <span className="sr-only">{props.mark === "needs-you" ? "Needs you" : "Unread"}</span>
        )}
        {props.picked && <span className="sr-only">Picked</span>}
        <span className="mt-0.5 line-clamp-2 text-sm leading-[1.35] text-muted-foreground">
          {props.description}
        </span>
      </span>
    </button>
  );
  return (
    <li
      className={cn(
        "relative rounded-card transition-colors duration-(--dur-1) hover:bg-sidebar-accent",
        arrival,
        props.selected && "bg-foreground/8 hover:bg-foreground/8",
      )}
    >
      {props.menu ? (
        <ContextMenu>
          <ContextMenuTrigger render={button} />
          <ContextMenuContent>{props.menu}</ContextMenuContent>
        </ContextMenu>
      ) : (
        button
      )}
      {props.actions && <div className="flex gap-1.5 pb-2.5 pl-[47px]">{props.actions}</div>}
      <span className="pointer-events-none absolute right-[11px] bottom-[9px] text-xs text-muted-foreground tabular-nums">
        {props.age}
      </span>
    </li>
  );
}
