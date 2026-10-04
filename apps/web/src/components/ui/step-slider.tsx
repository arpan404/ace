import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "@/lib/cn.ts";

/** Half the thumb: its centre never leaves the track, so the dots sit where it can stop. */
const inset = 12;

/** Where step `index` of `count` sits along the track. */
const at = (index: number, count: number) =>
  `calc(${inset}px + (100% - ${inset * 2}px) * ${count > 1 ? index / (count - 1) : 0})`;

/**
 * A slider over a few named steps (Low · Medium · High): a pill track with a dot per step, the
 * accent filling up to a 24px thumb. Arrow keys, Home and End move a step at a time; a press or
 * drag on the track lands on the nearest step. Drawn by hand rather than with Base UI's slider,
 * which would pull its shared code into the first paint's chunks.
 */
function StepSlider(props: {
  label: string;
  steps: readonly string[];
  /** Index of the current step; -1 when none is set (the thumb waits, dimmed, at the start). */
  value: number;
  /** How a step reads ("High"). */
  stepLabel(step: string): string;
  onValueChange(index: number): void;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  const count = props.steps.length;
  const last = count - 1;
  const value = props.value;
  const shown = Math.max(0, value);
  const set = (index: number) => {
    const next = Math.min(last, Math.max(0, index));
    if (!props.disabled && next !== value) props.onValueChange(next);
  };
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const span = box.width - inset * 2;
    if (span <= 0) return;
    set(Math.round(((event.clientX - box.left - inset) / span) * last));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: shown + 1,
      ArrowUp: shown + 1,
      ArrowLeft: value < 0 ? 0 : shown - 1,
      ArrowDown: value < 0 ? 0 : shown - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    set(next);
  };
  return (
    <div
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={value < 0 ? undefined : value}
      aria-valuetext={value < 0 ? "Not set" : props.stepLabel(props.steps[value] ?? "")}
      aria-disabled={props.disabled ? true : undefined}
      data-disabled={props.disabled ? "" : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (props.disabled) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        fromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
      }}
      className={cn(
        "relative h-6 w-full cursor-pointer touch-none rounded-full bg-secondary outline-none select-none focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_45%,transparent)] data-disabled:opacity-50",
        props.className,
      )}
    >
      {value >= 0 && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-full bg-ring"
          style={{ width: `calc(${at(value, count)} + ${inset}px)` }}
        />
      )}
      {props.steps.map((step, index) => (
        <span
          key={step}
          aria-hidden
          className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-40"
          style={{ left: at(index, count) }}
        />
      ))}
      <span
        aria-hidden
        className={cn(
          "absolute top-0 size-6 -translate-x-1/2 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3),0_0_0_0.5px_rgb(0_0_0/0.1)]",
          value < 0 && "opacity-60",
        )}
        style={{ left: at(shown, count) }}
      />
    </div>
  );
}

export { StepSlider };
