import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn.ts";

/** Half the thumb: its centre never leaves the track, so the dots sit where it can stop. */
const inset = 13;

/** Where step `index` of `count` sits along the track. */
const at = (index: number, count: number) =>
  `calc(${inset}px + (100% - ${inset * 2}px) * ${count > 1 ? index / (count - 1) : 0})`;

/** A tick's name, centred on its dot; the first and last align with the track's ends. */
function tickStyle(index: number, count: number) {
  if (index === 0) return { left: 0 };
  if (index === count - 1) return { right: 0 };
  return { left: at(index, count), transform: "translateX(-50%)" };
}

/** Moves the thumb and the fill together, quick and without overshoot past a stop. */
const glide = "transition-[left,width,scale] duration-(--dur-1) ease-smooth";

/**
 * A slider over a few named steps (Default · Low · Medium · High): a pill track with a dot per
 * step, the accent filling up to a 26px thumb that stands a little proud of the track, and each
 * step's name under its dot (the current one at full strength). Arrow keys, Page keys, Home and
 * End move it; a press or drag on the track lands on the nearest step, the thumb gliding there.
 * Drawn by hand rather than with Base UI's slider, which would pull its shared code into the
 * first paint's chunks.
 */
function StepSlider(props: {
  label: string;
  steps: readonly string[];
  /** Index of the current step. */
  value: number;
  /** How a step reads ("High"). */
  stepLabel(step: string): string;
  onValueChange(index: number): void;
  disabled?: boolean | undefined;
  className?: string | undefined;
}) {
  // The pointer dragging the thumb, if any: a second finger can neither move nor end its drag.
  const [pointer, setPointer] = useState<number>();
  const count = props.steps.length;
  const last = count - 1;
  const value = Math.min(last, Math.max(0, props.value));
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
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== pointer) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setPointer(undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: value + 1,
      ArrowUp: value + 1,
      PageUp: value + 1,
      ArrowLeft: value - 1,
      ArrowDown: value - 1,
      PageDown: value - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    set(next);
  };
  return (
    <div className={cn("flex flex-col gap-2", props.className)}>
      <div
        role="slider"
        tabIndex={props.disabled ? -1 : 0}
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={value}
        aria-valuetext={props.stepLabel(props.steps[value] ?? "")}
        aria-disabled={props.disabled ? true : undefined}
        data-disabled={props.disabled ? "" : undefined}
        data-dragging={pointer !== undefined ? "" : undefined}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (props.disabled || event.button !== 0 || pointer !== undefined) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setPointer(event.pointerId);
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.pointerId === pointer) fromPointer(event);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        className="group relative h-[22px] w-full cursor-pointer touch-none rounded-full bg-secondary outline-none select-none data-disabled:cursor-default data-disabled:opacity-50 data-dragging:cursor-grabbing"
      >
        <span
          aria-hidden
          className={cn("absolute inset-y-0 left-0 rounded-full bg-ring", glide)}
          style={{ width: `calc(${at(value, count)} + ${inset}px)` }}
        />
        {props.steps.map((step, index) => (
          <span
            key={step}
            aria-hidden
            className={cn(
              "absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
              index < value ? "bg-white/70" : "bg-current opacity-30",
            )}
            style={{ left: at(index, count) }}
          />
        ))}
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 size-[26px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3),0_0_0_0.5px_rgb(0_0_0/0.12)] group-focus-visible:shadow-[0_0_0_2px_var(--popover),0_0_0_4px_var(--ring)] group-data-dragging:scale-110",
            glide,
          )}
          style={{ left: at(value, count) }}
        />
      </div>
      <div aria-hidden className="relative h-4 text-xs leading-4 text-subtle-foreground">
        {props.steps.map((step, index) => (
          <span
            key={step}
            className={cn(
              "absolute top-0 whitespace-nowrap transition-colors duration-(--dur-1)",
              index === value && "font-medium text-foreground",
            )}
            style={tickStyle(index, count)}
          >
            {props.stepLabel(step)}
          </span>
        ))}
      </div>
    </div>
  );
}

export { StepSlider };
