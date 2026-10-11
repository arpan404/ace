import { CaretRightIcon } from "@phosphor-icons/react";
import type { WorkLogHeadline } from "@ace/ui-core";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * The work log's header; `work-log.tsx` binds it to the live thread. Its rows
 * (`work-log-steps.tsx`) load after first paint: logs start collapsed.
 */

/** "Worked for 4m 12s ›  Explored 6 files · Ran 3 commands", and the live step while closed. */
export function WorkLogHeader(props: {
  headline: WorkLogHeadline;
  open: boolean;
  panel: string;
  onToggle(): void;
}) {
  const { headline, open } = props;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={props.panel}
        onClick={props.onToggle}
        className="group inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-sm px-1.5 text-[13.5px] text-muted-foreground transition-colors duration-(--dur-1) hover:text-foreground hover:underline"
      >
        <span className={headline.running ? "shrink-0 shimmer" : "shrink-0"}>{headline.label}</span>
        <CaretRightIcon
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-(--dur-2) ease-spring",
            open && "rotate-90",
          )}
        />
        {headline.counts && (
          <span className="ml-1 truncate text-sm text-subtle-foreground">{headline.counts}</span>
        )}
      </button>
      {headline.current && !open && (
        <p className="mt-1 flex items-center gap-2 text-ui text-muted-foreground">
          <Spinner />
          <span className="truncate">{headline.current}</span>
        </p>
      )}
    </>
  );
}
