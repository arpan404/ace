import { useMemo, type PointerEvent, type RefObject } from "react";
import { magnifyScales } from "./rail-magnify.ts";

/** The custom property each tick's length is scaled by; unset means resting. */
export const tickScaleProperty = "--tick-scale";

/**
 * Magnifies the rail's ticks around the pointer. Scales go straight onto each tick's style rather
 * than through React state, so following the pointer re-renders nothing; only ticks whose scale
 * changed are written. Each child of `rail` up to `count` is a tick button holding its line.
 */
export function useRailMagnify(
  rail: RefObject<HTMLElement | null>,
  count: number,
  height: number,
): {
  onPointerMove(event: PointerEvent<HTMLElement>): void;
  onPointerLeave(): void;
} {
  return useMemo(() => {
    const last = Math.max(1, count - 1);
    const ticks = Array.from({ length: count }, (_, index) => (index / last) * height);
    const draw = (pointer: number | undefined) => {
      const element = rail.current;
      if (!element) return;
      const scales = magnifyScales(pointer, ticks, height / last);
      scales.forEach((scale, index) => {
        const line = element.children[index]?.firstElementChild;
        if (!(line instanceof HTMLElement)) return;
        const value = scale === 1 ? "" : scale.toFixed(3);
        if (line.style.getPropertyValue(tickScaleProperty) === value) return;
        if (value) line.style.setProperty(tickScaleProperty, value);
        else line.style.removeProperty(tickScaleProperty);
      });
    };
    return {
      onPointerMove(event: PointerEvent<HTMLElement>) {
        draw(event.clientY - event.currentTarget.getBoundingClientRect().top);
      },
      onPointerLeave() {
        draw(undefined);
      },
    };
  }, [rail, count, height]);
}
