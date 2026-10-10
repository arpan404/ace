import { nearLimitPercent, type QuotaWindowView } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { formatResetCountdown } from "./format.ts";

/** Ink normally, amber from `nearLimitPercent`, red when the window is full: the rings' tones. */
export function windowTone(used: number): string {
  return used >= 100
    ? "bg-status-failed"
    : used >= nearLimitPercent
      ? "bg-status-needs-you"
      : "bg-foreground";
}

/**
 * One quota window as a labelled bar: its name, how much is used and when it resets, with the
 * time left. Where a ring has no room (the composer's usage tooltip, Activity).
 */
export function WindowBar(props: { window: QuotaWindowView; now: number }) {
  const used = props.window.usedPercent;
  const resetsAt = props.window.resetsAt;
  if (resetsAt !== null && resetsAt <= props.now)
    return (
      <span className="flex flex-col gap-1">
        <span className="flex items-baseline justify-between gap-4">
          <span>{props.window.label}</span>
          <span className="text-subtle-foreground">Unknown</span>
        </span>
        <span className="text-subtle-foreground">Waiting for a new provider reading</span>
      </span>
    );
  const resets = formatResetCountdown(resetsAt, props.now);
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-4">
        <span>{props.window.label}</span>
        <span className="tabular-nums">{used}%</span>
      </span>
      <span
        role="meter"
        aria-label={`${props.window.label} window`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={`${used}% used, ${resets}`}
        className="block h-1 overflow-hidden rounded-full bg-secondary"
      >
        <span
          style={{ width: `${Math.max(2, used)}%` }}
          className={cn("block h-full rounded-full", windowTone(used))}
        />
      </span>
      <span className="text-subtle-foreground">{resets}</span>
    </span>
  );
}
