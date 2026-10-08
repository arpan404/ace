import { CheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { Icon } from "@/components/icon.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.tsx";
import { compactViewRowClass } from "@/components/ui/view-row.tsx";
import { useArrival } from "@/lib/arrival.tsx";

/** One compact Activity row. Decisions belong to the detail, with context in its tooltip. */
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
      title={props.description}
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
        compactViewRowClass,
        "h-9 items-center justify-start text-left pr-12 py-0 hover:bg-transparent aria-[current=page]:bg-transparent",
      )}
    >
      <span
        data-tone={!props.picked && props.mark === "needs-you" ? "needs-you" : undefined}
        className={cn(
          "grid size-4 shrink-0 place-items-center",
          props.picked && "text-primary",
          !props.picked && props.mark === "needs-you" && "text-(--tone-text)",
          !props.picked && props.mark === "unread" && "text-foreground",
          !props.picked && !props.mark && "text-muted-foreground",
        )}
      >
        {props.picked ? <Icon icon={CheckIcon} size={14} /> : props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-ui",
            props.mark ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {props.title}
        </span>
        {props.mark && (
          <span className="sr-only">{props.mark === "needs-you" ? "Needs you" : "Unread"}</span>
        )}
        {props.picked && <span className="sr-only">Picked</span>}
      </span>
    </button>
  );
  return (
    <li
      className={cn(
        "relative rounded-sm transition-colors duration-(--dur-1) hover:bg-sidebar-accent",
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
      <span className="pointer-events-none absolute right-[11px] top-1/2 -translate-y-1/2 text-xs text-muted-foreground tabular-nums">
        {props.age}
      </span>
    </li>
  );
}
