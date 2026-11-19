import { useEffect, type RefObject } from "react";
import {
  approachSpadeLook,
  spadeEyes,
  spadeLookFromPointer,
  spadeLookSettled,
  spadePupilAt,
  spadePupilForSize,
  spadeRestLook,
  type SpadeLook,
} from "@ace/ui-core/spade";
import { useReducedMotion } from "@/lib/motion.ts";

/**
 * Spade's eyes follow the pointer while it is over the rail or the sidebar panel. One
 * `pointermove` on their shared container feeds a `requestAnimationFrame` loop that eases the
 * pupils toward the pointer (no React re-render per event: the loop writes the pupil and
 * catchlight positions through the DOM); `pointerleave` eases them back to rest. At rest no
 * loop runs and nothing listens outside the container. Under reduced motion the eyes stay at
 * rest.
 */
export function useSpadeFollow<T extends HTMLElement>(containerRef: RefObject<T | null>): void {
  const reduced = useReducedMotion();
  useEffect(() => {
    const container = containerRef.current;
    if (!container || reduced) return;
    const svg = container.querySelector("svg[data-mark='spade']");
    if (!svg) return;
    const seen = svg.getAttribute("width");
    const size = seen === null ? 20 : Number(seen);
    const { pupil, pad } = spadePupilForSize(Number.isFinite(size) ? size : 20);
    const eyes = spadeEyes.map((centre, index) => ({
      centre: { x: centre.x, y: centre.y },
      pupil: svg.querySelector(`[data-spade-pupil="${index}"]`),
      glint: svg.querySelector(`[data-spade-glint="${index}"]`),
    }));
    if (!eyes.some((eye) => eye.pupil)) return;

    const write = (look: SpadeLook) => {
      for (const eye of eyes) {
        if (!eye.pupil) continue;
        const at = spadePupilAt(eye.centre, pupil, pad, look);
        eye.pupil.setAttribute("cx", at.x.toFixed(2));
        eye.pupil.setAttribute("cy", at.y.toFixed(2));
        if (eye.glint) {
          eye.glint.setAttribute("cx", (at.x + pupil.rx * 0.38).toFixed(2));
          eye.glint.setAttribute("cy", (at.y - pupil.ry * 0.42).toFixed(2));
        }
      }
    };

    let current: SpadeLook = { ...spadeRestLook };
    let target: SpadeLook = { ...spadeRestLook };
    let pending: { x: number; y: number } | null = null;
    let frame = 0;
    const tick = () => {
      frame = 0;
      if (pending) {
        const rect = svg.getBoundingClientRect();
        target = spadeLookFromPointer(rect, pending);
      }
      current = approachSpadeLook(current, target);
      if (spadeLookSettled(current, target)) current = { ...target };
      write(current);
      if (!spadeLookSettled(current, target)) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      pending = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const onLeave = () => {
      pending = null;
      target = { ...spadeRestLook };
      schedule();
    };
    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerleave", onLeave);
    return () => {
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
      current = { ...spadeRestLook };
      target = { ...spadeRestLook };
      write(current);
    };
  }, [containerRef, reduced]);
}
