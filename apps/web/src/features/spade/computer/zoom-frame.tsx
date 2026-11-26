import { MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@ace/icons";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { clampZoom, fitView, panBy, zoomAt, type ZoomView } from "./zoom-math.ts";

/**
 * A frame the person zooms and pans: Fit, 100%, + and −, pinch or ctrl+scroll (at the pointer),
 * and a drag to pan (the middle button or Space+drag while they drive the surface; a plain drag
 * while they only watch). The surface inside keeps its own input: clicks land where they are
 * drawn, as the transform is part of what it measures.
 */
export function ZoomFrame(props: {
  children: ReactNode;
  /** The person's input goes to the surface now: a plain drag is theirs to send, not to pan. */
  acting: boolean;
  /** The scale that shows the surface at its real pixels, when known (relative to Fit). */
  native?: (() => number) | undefined;
  /** Where the zoom controls sit over the frame (classes of their holder). */
  controlsClass: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ZoomView>(fitView);
  const space = useRef(false);
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  }, [view]);
  const drag = useRef<{ x: number; y: number }>(undefined);
  const size = () => {
    const rect = box.current?.getBoundingClientRect();
    return {
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      left: rect?.left ?? 0,
      top: rect?.top ?? 0,
    };
  };
  const zoomTo = useCallback((scale: number, around?: { x: number; y: number }) => {
    const rect = box.current?.getBoundingClientRect();
    const at = around ?? { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
    setView((now) =>
      zoomAt(now, scale, at, { width: rect?.width ?? 0, height: rect?.height ?? 0 }),
    );
  }, []);
  // Ctrl+scroll and pinch (a ctrl+wheel in browsers) zoom: taken before the surface sees it.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        zoomTo(Math.exp(-event.deltaY * 0.01), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        return;
      }
      // A zoomed picture scrolls under the pointer while the person only watches.
      if (!props.acting && latest.current.scale > 1) {
        event.preventDefault();
        setView((now) => panBy(now, { x: -event.deltaX, y: -event.deltaY }, rect));
      }
    };
    element.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => element.removeEventListener("wheel", wheel, { capture: true });
  }, [props.acting, zoomTo]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space" && !(event.target instanceof HTMLTextAreaElement))
        space.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") space.current = false;
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);
  // The label is the real size: 100% is the surface's own pixels, Fit whatever fits.
  const percent = Math.round((view.scale / (props.native?.() ?? 1)) * 100);
  const controls = (
    <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
      <IconButton
        icon={MagnifyingGlassMinusIcon}
        label="Zoom out"
        onClick={() => zoomTo(clampZoom(view.scale / 1.25))}
      />
      <button
        type="button"
        aria-label="Fit to window"
        onClick={() => setView(fitView)}
        className="h-8 rounded-full px-2.5 text-ui text-white/70 focus-ring hover:bg-white/10 hover:text-white"
      >
        Fit
      </button>
      <button
        type="button"
        aria-label="Actual size"
        onClick={() => zoomTo(props.native?.() ?? 1)}
        className="h-8 min-w-12 rounded-full px-2.5 text-ui text-white/70 tabular-nums focus-ring hover:bg-white/10 hover:text-white"
      >
        {`${percent}%`}
      </button>
      <IconButton
        icon={MagnifyingGlassPlusIcon}
        label="Zoom in"
        onClick={() => zoomTo(clampZoom(view.scale * 1.25))}
      />
    </div>
  );
  return (
    <>
      <div
        ref={box}
        data-zoom={percent}
        onPointerDownCapture={(event) => {
          const pans = event.button === 1 || space.current || !props.acting;
          if (!pans || view.scale <= 1) {
            if (event.button === 1) event.preventDefault();
            return;
          }
          event.stopPropagation();
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (!from) return;
          drag.current = { x: event.clientX, y: event.clientY };
          const { width, height } = size();
          setView((now) =>
            panBy(now, { x: event.clientX - from.x, y: event.clientY - from.y }, { width, height }),
          );
        }}
        onPointerUp={() => (drag.current = undefined)}
        onPointerCancel={() => (drag.current = undefined)}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        <div
          className="absolute inset-0 flex flex-col origin-top-left *:min-h-0 *:flex-1"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          {props.children}
        </div>
      </div>
      <div className={props.controlsClass}>{controls}</div>
    </>
  );
}
