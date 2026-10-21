import { ArrowsOutSimpleIcon, GlobeSimpleIcon, XIcon } from "@phosphor-icons/react";
import { readJson, writeJson } from "@ace/ui-core";
import * as z from "zod/mini";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { cn } from "@/lib/cn.ts";
import { useCaptureSize } from "../preview/use-capture-size.ts";
import type { PreviewSource, ScreenFrame } from "../sources.ts";
import { useLocal } from "../store.ts";
import { frontPip } from "./floating-state.ts";
import { FramePicture } from "./frame-picture.tsx";
import { pageSize } from "./page-size.ts";
import {
  clampPip,
  defaultPipGeometry,
  stackPip,
  type PipGeometry,
  type PipPage,
} from "./pip-rules.ts";

const storageKey = "ace.browser.pip";
const Stored = z.object({ right: z.number(), bottom: z.number(), width: z.number() });

const windowSize = () => ({ width: innerWidth, height: innerHeight });
/** Where the person moved each thread's window this session; new ones stack from the last. */
const moved = new Map<string, PipGeometry>();
/** A press that travels less than this is a click, not a drag. */
const dragSlop = 4;

/**
 * The page in a small floating window inside the ace window, while the Browser is out of sight
 * and an agent browses or the page plays sound; one per thread, so several agents' pages can
 * stream at once. Drag it by its bar, resize it from its top-left corner; it remembers where
 * it was, and a new one stacks beside the others. A click on its bar or its page brings that
 * thread's Browser back in the panel; only × puts it away.
 *
 * It always draws the page's live video, in the desktop app too: a native view paints above
 * the whole window, so it can't be clipped to this box's rounded corners and it takes clicks
 * for itself. Meanwhile the desktop's page keeps running out of sight at its panel size, so
 * it never reloads or reflows.
 */
export function BrowserPip(props: {
  source: PreviewSource;
  threadId: string;
  /**
   * The page's newest picture. The caller reads it on each change of the source: read here, the
   * compiler would keep the first answer, as the source object itself never changes.
   */
  frame: ScreenFrame | undefined;
  page: PipPage;
  /** The thread's name, shown first in the bar. */
  threadTitle?: string | undefined;
  /** Its place among the windows floating now, for where a new one starts. */
  slot: number;
  onRestore(): void;
  onDismiss(): void;
}) {
  const { storage } = useLayout();
  const size = pageSize(props.threadId);
  const aspect = size.height / size.width;
  const [geometry, setGeometry] = useState<PipGeometry>(() => {
    const own = moved.get(props.threadId);
    if (own) return clampPip(own, windowSize(), aspect);
    const base = readJson(storage, storageKey, Stored, defaultPipGeometry);
    return stackPip(base, props.slot, windowSize(), aspect);
  });
  const save = (next: PipGeometry) => {
    moved.set(props.threadId, next);
    writeJson(storage, storageKey, next);
  };
  const front = useLocal(frontPip, (id) => id === props.threadId);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fit = () => setGeometry((current) => clampPip(current, windowSize(), aspect));
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [aspect]);

  const { source, threadId, frame } = props;
  // No native view shows the page while it floats: the daemon sends its video for this, at
  // this window's size.
  useEffect(() => source.nativeShown?.(threadId, false), [source, threadId]);
  useCaptureSize(source, threadId, body);

  /**
   * Dragging the bar moves it; dragging the corner resizes it (the right edge stays). A press
   * on the bar that doesn't travel is a click: it brings the page back.
   */
  const gesture = (kind: "move" | "resize") => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, geometry };
    let last = geometry;
    let dragged = false;
    const move = (pointer: globalThis.PointerEvent) => {
      const dx = pointer.clientX - start.x;
      const dy = pointer.clientY - start.y;
      if (!dragged && Math.hypot(dx, dy) < dragSlop) return;
      dragged = true;
      last = clampPip(
        kind === "move"
          ? {
              ...start.geometry,
              right: start.geometry.right - dx,
              bottom: start.geometry.bottom - dy,
            }
          : { ...start.geometry, width: start.geometry.width - dx },
        windowSize(),
        aspect,
      );
      setGeometry(last);
    };
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", stop);
      if (dragged) save(last);
    };
    const up = () => {
      stop();
      if (!dragged && kind === "move") props.onRestore();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", stop);
  };

  const height = Math.round(geometry.width * aspect);
  return createPortal(
    <section
      aria-label={`Picture in picture: ${props.page.title}`}
      data-browser-pip=""
      style={{ right: geometry.right, bottom: geometry.bottom, width: geometry.width }}
      onPointerDownCapture={() => frontPip.set(() => threadId)}
      className={cn(
        "fixed flex flex-col overflow-hidden rounded-lg ace-floating-solid shadow-glass",
        front ? "z-41" : "z-40",
      )}
    >
      {/* The bar drags; a click on it is a mouse shortcut, "Show in the panel" the keyboard path. */}
      <div
        data-pip-bar=""
        onPointerDown={gesture("move")}
        className="flex h-7 shrink-0 cursor-grab touch-none items-center gap-1 pr-0.5 pl-1.5 select-none active:cursor-grabbing"
      >
        {props.page.favicon ? (
          <img
            src={props.page.favicon}
            alt=""
            aria-hidden
            draggable={false}
            className="size-3.5 shrink-0 rounded-xs"
          />
        ) : (
          <GlobeSimpleIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
        )}
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 px-0.5 text-xs">
          {props.threadTitle && (
            <span className="max-w-[60%] shrink-0 truncate text-foreground">
              {props.threadTitle}
            </span>
          )}
          <span className="min-w-0 truncate text-muted-foreground">{props.page.title}</span>
        </span>
        <IconButton
          size="sm"
          icon={ArrowsOutSimpleIcon}
          label={`Show ${props.page.title} in the panel`}
          onClick={props.onRestore}
        />
        <IconButton
          size="sm"
          icon={XIcon}
          label="Close picture in picture"
          onClick={props.onDismiss}
        />
      </div>
      {/* A click on the picture is a mouse shortcut; "Show in the panel" is the keyboard path. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- see above */}
      <div
        ref={body}
        data-pip-page=""
        style={{ height }}
        className="relative cursor-pointer bg-background"
        onClick={props.onRestore}
      >
        {frame && (
          <FramePicture
            frame={frame}
            alt={`Live view of ${props.page.url}`}
            className="absolute inset-0 size-full object-contain"
          />
        )}
      </div>
      <div
        role="separator"
        aria-label="Resize picture in picture"
        onPointerDown={gesture("resize")}
        className="absolute top-0 left-0 size-3 cursor-nwse-resize"
      />
    </section>,
    document.body,
  );
}
