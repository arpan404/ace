import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/cn.ts";
import { draggedSize, drawnScale, responsive, stageInset, type ResizeHandle } from "./devices.ts";
import type { PageTools } from "./use-page-tools.ts";

const handles: { handle: ResizeHandle; label: string; className: string; grip: string }[] = [
  {
    handle: "right",
    label: "Resize width",
    className: "top-0 -right-3 h-full w-3 cursor-ew-resize",
    grip: "h-8 w-1",
  },
  {
    handle: "bottom",
    label: "Resize height",
    className: "-bottom-3 left-0 h-3 w-full cursor-ns-resize",
    grip: "h-1 w-8",
  },
  {
    handle: "corner",
    label: "Resize",
    className: "-right-3 -bottom-3 size-3 cursor-nwse-resize",
    grip: "size-1.5",
  },
];

/**
 * The page area in device mode: the device's viewport, framed and centred at the top of the
 * area, drawn at the toolbar's scale. In Responsive mode its right, bottom and corner handles
 * resize it live. `frame` is the viewport box itself: the desktop's native view is placed
 * exactly over it, and the screencast picture fills it.
 */
export function DeviceStage(props: {
  tools: PageTools;
  frame: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const { tools, frame, children } = props;
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setRoom({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const size = tools.size;
  // A toolbar shown for the first time starts at the room there is, Responsive.
  const { startAt } = tools;
  useLayoutEffect(() => {
    if (!size && room && room.width > 0 && room.height > 0)
      startAt(room.width - 2 * stageInset, room.height - 2 * stageInset);
  }, [size, room, startAt]);
  const scale = size && room ? drawnScale(tools.scale, size, room) : 1;
  const drag = useRef<{
    handle: ResizeHandle;
    x: number;
    y: number;
    start: { width: number; height: number };
    scale: number;
  }>(undefined);
  const begin = (handle: ResizeHandle) => (event: PointerEvent<HTMLDivElement>) => {
    if (!size || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { handle, x: event.clientX, y: event.clientY, start: size, scale };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active) return;
    const next = draggedSize(
      active.start,
      active.handle,
      { dx: event.clientX - active.x, dy: event.clientY - active.y },
      active.scale,
    );
    tools.dragTo(next.width, next.height);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active) return;
    drag.current = undefined;
    const next = draggedSize(
      active.start,
      active.handle,
      { dx: event.clientX - active.x, dy: event.clientY - active.y },
      active.scale,
    );
    tools.resize(next.width, next.height);
  };
  return (
    <div
      ref={stage}
      data-device-stage=""
      className="absolute inset-0 overflow-hidden bg-foreground/3"
    >
      {size && (
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ top: stageInset, width: size.width * scale, height: size.height * scale }}
        >
          <div
            ref={frame}
            data-device-frame=""
            aria-label={`Device viewport, ${size.width} by ${size.height}`}
            role="group"
            className="relative size-full overflow-hidden bg-background shadow-[0_0_0_1px_var(--border)]"
          >
            {children}
          </div>
          {size.preset === responsive &&
            handles.map((each) => (
              <div
                key={each.handle}
                role="separator"
                aria-label={each.label}
                aria-orientation={each.handle === "bottom" ? "horizontal" : "vertical"}
                onPointerDown={begin(each.handle)}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                className={cn("group absolute flex items-center justify-center", each.className)}
              >
                <span
                  className={cn(
                    "rounded-full bg-foreground/20 transition-colors duration-(--motion-fast) group-hover:bg-foreground/45",
                    each.grip,
                  )}
                />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
