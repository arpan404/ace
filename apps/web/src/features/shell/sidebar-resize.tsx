import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { nextFrame } from "@/lib/next-frame.ts";
import { sidebarMaximum, sidebarSize, sidebarWidth } from "./sidebar-size.ts";

interface Drag {
  pointer: number;
  startX: number;
  startWidth: number;
  width: number;
  element: HTMLDivElement;
  userSelect: string;
  cursor: string;
  cancelFrame?: (() => void) | undefined;
}

/** Pointer movement changes one DOM width per frame; preferences update only on release. */
export function SidebarResize(props: {
  sidebar: RefObject<HTMLDivElement | null>;
  width: number;
  onWidth(width: number): void;
  onCollapse(): void;
}) {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const drag = useRef<Drag | undefined>(undefined);
  const cleanup = useCallback(() => {
    const run = drag.current;
    if (!run) return;
    run.cancelFrame?.();
    run.element.style.removeProperty("width");
    if (document.body.style.userSelect === "none") document.body.style.userSelect = run.userSelect;
    if (document.body.style.cursor === "col-resize") document.body.style.cursor = run.cursor;
    drag.current = undefined;
  }, []);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      cleanup();
    };
  }, [cleanup]);
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const run = drag.current;
    if (!run || run.pointer !== event.pointerId) return;
    const width = run.startWidth + event.clientX - run.startX;
    cleanup();
    event.currentTarget.removeAttribute("data-collapse-ready");
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) return;
    if (width < sidebarSize.collapse) {
      run.element.style.width = `${sidebarSize.minimum}px`;
      props.onCollapse();
    } else props.onWidth(sidebarWidth(width, window.innerWidth));
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize sidebar"
      aria-description="Drag to resize. Drag farther left to hide. Arrow keys resize; Enter hides the sidebar."
      aria-orientation="vertical"
      aria-valuemin={sidebarSize.minimum}
      aria-valuemax={sidebarMaximum(viewport)}
      aria-valuenow={Math.round(sidebarWidth(props.width, viewport))}
      className="group/resize absolute inset-y-0 -right-1 z-20 flex w-2 cursor-col-resize touch-none items-center justify-center focus-ring [-webkit-app-region:no-drag]"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.pointerType === "touch") return;
        const element = props.sidebar.current;
        if (!element) return;
        event.preventDefault();
        event.currentTarget.focus();
        cleanup();
        drag.current = {
          pointer: event.pointerId,
          startX: event.clientX,
          startWidth: element.getBoundingClientRect().width,
          width: element.getBoundingClientRect().width,
          element,
          userSelect: document.body.style.userSelect,
          cursor: document.body.style.cursor,
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const run = drag.current;
        if (!run || run.pointer !== event.pointerId) return;
        run.width = run.startWidth + event.clientX - run.startX;
        event.currentTarget.toggleAttribute(
          "data-collapse-ready",
          run.width < sidebarSize.collapse,
        );
        if (run.cancelFrame) return;
        run.cancelFrame = nextFrame(() => {
          run.cancelFrame = undefined;
          run.element.style.width = `${sidebarWidth(run.width, window.innerWidth)}px`;
        });
      }}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={() => cleanup()}
      onDoubleClick={props.onCollapse}
      onKeyDown={(event) => {
        let width: number | undefined;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          cleanup();
          props.onCollapse();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cleanup();
          return;
        }
        if (event.key === "Home") width = sidebarSize.minimum;
        else if (event.key === "End") width = sidebarMaximum(viewport);
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
          width =
            sidebarWidth(props.width, viewport) +
            (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 16);
        if (width === undefined) return;
        event.preventDefault();
        props.onWidth(sidebarWidth(width, viewport));
      }}
    >
      <span
        aria-hidden
        className="h-full w-px bg-transparent transition-colors group-hover/resize:bg-border group-focus-visible/resize:bg-ring group-data-collapse-ready/resize:bg-ring motion-reduce:transition-none"
      />
    </div>
  );
}
