import { cn } from "@/lib/cn.ts";

/**
 * A thin determinate bar: a 4px track with the fill grown from the left in the accent colour,
 * named and valued for assistive tech (`role=progressbar`). Without a value it holds a sliver,
 * so a job that has started never reads as empty.
 */
export function ProgressBar(props: {
  label: string;
  /** 0–100, or undefined while the share isn't known yet. */
  value: number | undefined;
  /** What a screen reader says: "Receiving objects, 52%". Defaults to the percent. */
  valueText?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value}
      aria-valuetext={
        props.valueText ?? (props.value === undefined ? undefined : `${props.value}%`)
      }
      className={cn("h-1 overflow-hidden rounded-full bg-input", props.className)}
    >
      <div
        className="h-full origin-left bg-ring transition-transform duration-(--dur-1) ease-smooth"
        style={{ transform: `scaleX(${(props.value ?? 4) / 100})` }}
      />
    </div>
  );
}
