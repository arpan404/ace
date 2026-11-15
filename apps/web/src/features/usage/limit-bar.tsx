import type { AccountWindow } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

/**
 * What is left, in grey ink only: solid up to what the pace still leaves at the reset, faint for
 * what that pace will use. A window that runs out before its reset is all faint; one that is out
 * is the empty track. State is said in the row's words, never by the bar's colour.
 */
export function LimitBar(props: {
  window: AccountWindow;
  /** The card's thinner bar. */
  size?: "sm" | undefined;
}) {
  const { window } = props;
  const left = window.stale ? 0 : window.leftPercent;
  const keep = window.stale || window.runsOutAt !== null ? 0 : (window.leftAtReset ?? left);
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
        "relative overflow-hidden rounded-full bg-faint-foreground/30",
        props.size === "sm" ? "h-1.5" : "h-2",
      )}
    >
      {left > keep && (
        <span
          data-pace=""
          style={{ width: `${left}%` }}
          className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/40"
        />
      )}
      {keep > 0 && (
        <span
          data-keep=""
          style={{ width: `${Math.min(keep, left)}%` }}
          className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground"
        />
      )}
    </div>
  );
}
