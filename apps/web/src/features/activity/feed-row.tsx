import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { useArrival } from "@/lib/arrival.tsx";

/**
 * One Activity sidebar row: a 26px icon tile, the title (13/500) with its context under it,
 * the age at the bottom right, and optional inline actions. Read rows drop to the muted
 * grey; the selected row carries the 7% ink fill.
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
}) {
  const arrival = useArrival();
  return (
    <li
      className={cn(
        "relative rounded-[10px] transition-colors duration-(--dur-1) hover:bg-sidebar-accent",
        arrival,
        props.selected &&
          "bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)] hover:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
      )}
    >
      <button
        type="button"
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onSelect}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-[10px] px-[11px] pt-[9px] pb-2 pr-12 text-left outline-none focus-visible:shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--ring)_45%,transparent)]"
      >
        <span
          className={cn(
            "mt-px grid size-[26px] place-items-center rounded-sm bg-secondary",
            props.mark ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {props.icon}
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
          <span className="mt-0.5 line-clamp-2 text-[12px] leading-[1.35] text-subtle-foreground">
            {props.description}
          </span>
        </span>
      </button>
      {props.actions && <div className="flex gap-1.5 pb-2.5 pl-[47px]">{props.actions}</div>}
      <span className="pointer-events-none absolute right-[11px] bottom-[9px] text-xs text-subtle-foreground tabular-nums">
        {props.age}
      </span>
    </li>
  );
}
