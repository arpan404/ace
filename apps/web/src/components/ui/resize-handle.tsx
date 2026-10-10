import { cn } from "@/lib/cn.ts";
import { useRef, useState } from "react";

export function clampSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}

/**
 * Drag or arrow-key handle for a resizable pane edge. `edge` is the side of the pane it sits
 * on: dragging away from the pane grows it. Accessible as a focusable separator with a value.
 */
function ResizeHandle(props: {
  label: string;
  edge: "left" | "top";
  size: number;
  min: number;
  max: number;
  onResize(size: number): void;
  /** Fires once when a drag ends, for persisting. */
  onResizeEnd?(size: number): void;
  onDraggingChange?(dragging: boolean): void;
  className?: string;
}) {
  const drag = useRef<{ pointerId: number; start: number; size: number; last: number } | undefined>(
    undefined,
  );
  const [dragging, setDragging] = useState(false);
  const vertical = props.edge === "left";
  const clamp = (value: number) => clampSize(value, props.min, props.max);
  const step = (delta: number) => {
    const next = clamp(props.size + delta);
    props.onResize(next);
    props.onResizeEnd?.(next);
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    props.onDraggingChange?.(false);
    props.onResizeEnd?.(current.last);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={props.label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuenow={props.size}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      data-dragging={dragging ? "" : undefined}
      className={cn(
        "absolute z-[3] outline-none transition-colors duration-(--dur-1) hover:bg-ring/45 focus-visible:bg-ring/45 data-dragging:bg-ring/45",
        vertical
          ? "inset-y-0 -left-[3px] w-1.5 cursor-col-resize"
          : "inset-x-0 -top-[3px] h-1.5 cursor-row-resize",
        props.className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const start = vertical ? event.clientX : event.clientY;
        drag.current = { pointerId: event.pointerId, start, size: props.size, last: props.size };
        setDragging(true);
        props.onDraggingChange?.(true);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const position = vertical ? event.clientX : event.clientY;
        // The pane is right of (or below) the handle, so moving towards the origin grows it.
        current.last = clamp(current.size + (current.start - position));
        props.onResize(current.last);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const grow = vertical ? "ArrowLeft" : "ArrowUp";
        const shrink = vertical ? "ArrowRight" : "ArrowDown";
        const amount = event.shiftKey ? 64 : 16;
        if (event.key === grow) step(amount);
        else if (event.key === shrink) step(-amount);
        else if (event.key === "Home") step(props.min - props.size);
        else if (event.key === "End") step(props.max - props.size);
        else return;
        event.preventDefault();
      }}
    />
  );
}

export { ResizeHandle };
