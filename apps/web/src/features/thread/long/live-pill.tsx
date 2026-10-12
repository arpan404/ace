import { CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { floatingControl, floatingHover, floatingMotion } from "./floating.ts";

/**
 * Back to the live end: a pill centred over the composer, clear of it and of the strip on its
 * top edge (`--composer-clearance` is the dock's measured height). It says how many items
 * arrived since the reader left, and that following is paused while the agent works.
 */
export function LivePill(props: {
  newItems: number;
  /** More arrived than the live window holds. */
  more: boolean;
  paused: boolean;
  /** Leaving: it plays its exit and takes no input. */
  phase?: "enter" | "exit";
  onClick(): void;
}) {
  const count = props.newItems
    ? `${props.newItems.toLocaleString("en-US")}${props.more ? "+" : ""} new`
    : "";
  const leaving = props.phase === "exit";
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={count ? `Jump to live, ${count}` : "Jump to live"}
      aria-hidden={leaving || undefined}
      inert={leaving}
      className={cn(
        floatingControl,
        floatingMotion(props.phase ?? "enter"),
        floatingHover,
        // Centred on the composer, which a pinned summary insets on the right.
        "absolute bottom-[min(calc(var(--composer-clearance,0px)+0.75rem),calc(100%-2.75rem))] left-[calc(50%-var(--summary-inset,0px)/2)] z-20 -translate-x-1/2 pr-3.5 pl-3 font-medium whitespace-nowrap text-foreground",
        "transition-[background-color,box-shadow] duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "touch-hit pointer-coarse:h-9",
      )}
    >
      <CaretDownIcon aria-hidden size={14} weight="bold" className="text-muted-foreground" />
      {props.paused && (
        <span className="font-normal text-muted-foreground">Following paused ·</span>
      )}
      Jump to live
      {count && (
        <span className="-mr-1 rounded-full bg-accent px-1.5 text-xs tabular-nums text-foreground">
          {count}
        </span>
      )}
    </button>
  );
}
