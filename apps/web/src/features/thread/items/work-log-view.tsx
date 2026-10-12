import { CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";

/*
 * A settled work log's header; `work-log.tsx` binds it to the thread. Its steps load when it
 * opens (`turn-work.tsx`): logs start folded.
 */

/** "Worked for 1m 43s ›" with the turn's time at the right, over one hairline. */
export function WorkLogHeader(props: {
  label: string;
  /** When the turn ended, "1:26 PM". */
  time: string | undefined;
  open: boolean;
  panel: string;
  onToggle(): void;
}) {
  return (
    <div className="flex min-h-8 items-center gap-3 border-b border-border pb-2">
      <button
        type="button"
        aria-expanded={props.open}
        aria-controls={props.panel}
        onClick={props.onToggle}
        className="group inline-flex min-w-0 items-center gap-1.5 text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground pointer-coarse:min-h-10"
      >
        <span className="truncate">{props.label}</span>
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
            props.open && "rotate-90",
          )}
        />
      </button>
      {props.time && (
        <span className="ml-auto shrink-0 text-xs tabular-nums text-subtle-foreground">
          {props.time}
        </span>
      )}
    </div>
  );
}

/** Rows standing in for a log's steps while they load. */
export function StepsSkeleton() {
  return (
    <div role="status" aria-label="Loading steps" className="flex flex-col gap-2 py-1.5 pl-1.5">
      {[62, 48, 70].map((width) => (
        <div key={width} className="flex h-4 items-center gap-2">
          <span className="fx-skeleton size-3.5 shrink-0 rounded-sm" />
          <span className="fx-skeleton h-3" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}
