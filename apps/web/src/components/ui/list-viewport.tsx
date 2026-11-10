import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { LoadingRegion, Skeleton } from "./skeleton.tsx";

/*
 * One list area under a combobox (the palette's steps, the location field), the same box
 * whatever it shows: loading rows, a status line, or the options. The viewport owns the padding
 * and the height, so nothing inside adds insets of its own and nothing jumps when the rows come.
 */

/** A palette option's size and insets (`CommandOption`, `CommandItem`), 44px tall on touch. */
export const optionGeometry = "h-9 gap-[9px] px-2.5 pointer-coarse:h-11";

/** The scrolling box the list's states take turns in. Give it a fixed height. */
export function ListViewport(props: {
  children: ReactNode;
  className?: string | undefined;
  onPointerLeave?: (() => void) | undefined;
}) {
  return (
    <div
      onPointerLeave={props.onPointerLeave}
      className={cn("min-h-0 scroll-py-1 overflow-y-auto overscroll-contain p-1", props.className)}
    >
      {props.children}
    </div>
  );
}

/** Rows standing in for options while they load, the same size as the options (`geometry`). */
export function OptionSkeletons(props: { label: string; rows: number; geometry: string }) {
  return (
    <LoadingRegion label={props.label} className="flex flex-col">
      {Array.from({ length: props.rows }, (_, index) => {
        const style = { animationDelay: `${index * 70}ms` };
        return (
          <span key={index} className={cn("flex shrink-0 items-center", props.geometry)}>
            <Skeleton className="size-4 shrink-0 rounded-xs" style={style} />
            <Skeleton className="h-3" style={{ ...style, width: `${46 + ((index * 23) % 30)}%` }} />
          </span>
        );
      })}
    </LoadingRegion>
  );
}

/**
 * What the list says in place of its rows (offline, empty, couldn't read): one plain sentence
 * from the left, then its text actions.
 */
export function ListStatus(props: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-1 gap-y-1 px-2.5 py-2 text-ui text-muted-foreground"
    >
      <span className="mr-1 max-w-[60ch]">{props.children}</span>
      {props.actions}
    </div>
  );
}
