import { CaretRightIcon } from "@phosphor-icons/react";
import type { WorkLogHeadline } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/*
 * A settled work log's header; `work-log.tsx` binds it to the thread. Its steps load when it
 * opens (`turn-work.tsx`): logs start folded.
 */

/** "Worked for 2m 5s ›  Explored 3 files · 2 searches · ran 2 commands". */
export function WorkLogHeader(props: {
  headline: WorkLogHeadline;
  open: boolean;
  panel: string;
  onToggle(): void;
}) {
  const { headline, open } = props;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={props.panel}
      onClick={props.onToggle}
      className="group inline-flex h-7 pointer-coarse:min-h-10 max-w-full items-center gap-1.5 rounded-sm text-ui text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground"
    >
      <span className="shrink-0">{headline.label}</span>
      <CaretRightIcon
        aria-hidden
        size={14}
        className={cn(
          "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
          open && "rotate-90",
        )}
      />
      {headline.counts && (
        <span className="ml-2 min-w-0 truncate text-subtle-foreground">{headline.counts}</span>
      )}
    </button>
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
