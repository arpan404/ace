import type { AccountWindow } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/**
 * What is left as a fat bar. Lasting: ink up to where the pace leaves it at the reset (the
 * marker), amber for what that pace still uses. Running out: all of it red.
 */
export function LimitBar(props: {
  window: AccountWindow;
  runsOut: boolean;
  /** The card's thinner bar. */
  size?: "sm" | undefined;
}) {
  const { window } = props;
  const left = window.stale ? 0 : window.leftPercent;
  const marker = props.runsOut || window.stale ? null : window.leftAtReset;
  const valuetext = window.stale ? "Not used since its reset" : `${window.leftPercent}% left`;
  return (
    <div
      role="meter"
      aria-label={window.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={window.leftPercent}
      aria-valuetext={valuetext}
      className={cn(
        "relative overflow-hidden rounded-full",
        props.size === "sm" ? "h-1.5" : "h-2.5",
        window.leftPercent <= 0 && !window.stale ? "bg-status-failed/20" : "bg-faint-foreground/30",
      )}
    >
      <span className="absolute inset-0">
        {props.runsOut ? (
          <span
            data-runs-out=""
            style={{ width: `${left}%` }}
            className="absolute inset-y-0 left-0 rounded-r-full bg-status-failed"
          />
        ) : (
          <>
            <span
              style={{ width: `${marker ?? left}%` }}
              className={cn(
                "absolute inset-y-0 left-0 bg-muted-foreground",
                // The fill's end is round; where the pace part follows, the notch parts them.
                !(marker !== null && marker < left) && "rounded-r-full",
              )}
            />
            {marker !== null && marker < left && (
              <span
                data-pace=""
                style={{ left: `${marker}%`, width: `${left - marker}%` }}
                className="usage-pace absolute inset-y-0 rounded-r-full"
              />
            )}
          </>
        )}
      </span>
      {/* Where the pace leaves it at the reset: a notch in the bar's own height. */}
      {marker !== null && marker < left && (
        <span
          aria-hidden
          style={{ left: `${marker}%` }}
          className="absolute inset-y-0 w-[3px] -translate-x-1/2 bg-background"
        />
      )}
    </div>
  );
}
