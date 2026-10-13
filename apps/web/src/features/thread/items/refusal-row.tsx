import type { ToolRefusal } from "@ace/ui-core";
import { CaretRightIcon, RobotIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn.ts";

/**
 * A refused agent tool as one failed tool row: the icon, what was refused, the reason once,
 * and ×N when the agent tried the same thing again. Details only when they say more.
 */
export function RefusalRow(props: { refusal: ToolRefusal; count: number }) {
  const { refusal, count } = props;
  const [open, setOpen] = useState(false);
  const details = useId();
  return (
    <div role="group" aria-label={`${refusal.label}: ${refusal.reason}`} className="text-ui">
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <RobotIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <span className="shrink-0 text-foreground">{refusal.label}</span>
        {count > 1 && (
          <span
            aria-label={`${count} times`}
            className="shrink-0 text-subtle-foreground tabular-nums"
          >
            ×{count}
          </span>
        )}
        <span className="min-w-0 truncate text-muted-foreground" title={refusal.reason}>
          {refusal.reason}
        </span>
        {refusal.detail && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={details}
            onClick={() => setOpen(!open)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-subtle-foreground hover:text-foreground"
          >
            Details
            <CaretRightIcon
              aria-hidden
              size={12}
              className={cn("transition-transform duration-(--motion-base)", open && "rotate-90")}
            />
          </button>
        )}
      </div>
      {open && refusal.detail && (
        <p id={details} className="fx-rise-in mt-1 ml-6 whitespace-pre-wrap text-muted-foreground">
          {refusal.detail}
        </p>
      )}
    </div>
  );
}
