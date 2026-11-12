import { quotaWindowShort, type QuotaWindowView } from "@ace/ui-core";
import { Fragment } from "react";
import { formatResetCountdown, windowTone } from "@/features/accounts/index.ts";
import { cn } from "@/lib/cn.ts";

/**
 * An account's headline usage windows at the end of its row, one line each: the window's short
 * name, a bar of what is left, and "<n>% left". A reading past its reset says it hasn't been
 * reported again yet rather than imply room.
 */
export function AccountWindows(props: { windows: readonly QuotaWindowView[]; now: number }) {
  return (
    <span className="grid shrink-0 grid-cols-[auto_4rem_auto] items-center gap-x-2 gap-y-1 text-xs text-subtle-foreground">
      {props.windows.map((window) => {
        const short = quotaWindowShort(window);
        if (window.resetsAt !== null && window.resetsAt <= props.now)
          return (
            <span
              key={window.id}
              title="Waiting for a new provider reading"
              className="col-span-3 justify-self-end whitespace-nowrap"
            >
              {short} · Not reported yet
            </span>
          );
        const left = Math.max(0, 100 - window.usedPercent);
        const resets = formatResetCountdown(window.resetsAt, props.now);
        return (
          <Fragment key={window.id}>
            <span className="max-w-40 truncate whitespace-nowrap" title={window.label}>
              {short}
            </span>
            <span
              role="meter"
              aria-label={`${window.label} window`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={left}
              aria-valuetext={`${left}% left, ${resets}`}
              title={resets}
              className="h-1 overflow-hidden rounded-full bg-secondary"
            >
              <span
                style={{ width: `${left}%` }}
                className={cn("block h-full rounded-full", windowTone(window.usedPercent))}
              />
            </span>
            <span className="text-right whitespace-nowrap text-foreground tabular-nums">
              {left}% left
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}
