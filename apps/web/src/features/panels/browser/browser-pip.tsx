import { ArrowsOutSimpleIcon, GlobeSimpleIcon, XIcon } from "@phosphor-icons/react";
import { readJson, writeJson } from "@ace/ui-core";
import * as z from "zod/mini";
import { useEffect, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useLayout } from "@/lib/layout.tsx";
import type { PreviewSource, ScreenFrame } from "../sources.ts";
import { FramePicture } from "./frame-picture.tsx";
import { pageSize } from "./page-size.ts";
import { clampPip, defaultPipGeometry, type PipGeometry, type PipPage } from "./pip-rules.ts";

const storageKey = "ace.browser.pip";
const Stored = z.object({ right: z.number(), bottom: z.number(), width: z.number() });

const windowSize = () => ({ width: innerWidth, height: innerHeight });

/**
 * The page in a small floating window inside the ace window, while the Browser is out of sight
 * and an agent browses or the page plays sound. Drag it by its bar, resize it from its top-left
 * corner; it remembers where it was. A click on its title or its page brings the Browser back
 * in the panel; only × puts it away.
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
  onRestore(): void;
  onDismiss(): void;
}) {
  const { storage } = useLayout();
  const size = pageSize(props.threadId);
  const aspect = size.height / size.width;
  const [geometry, setGeometry] = useState<PipGeometry>(() =>
    clampPip(readJson(storage, storageKey, Stored, defaultPipGeometry), windowSize(), aspect),
  );
  const save = (next: PipGeometry) => writeJson(storage, storageKey, next);
  useEffect(() => {
    const fit = () => setGeometry((current) => clampPip(current, windowSize(), aspect));
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [aspect]);

  const { source, threadId, frame } = props;
  // No native view shows the page while it floats: the daemon sends its video for this.
  useEffect(() => source.nativeShown?.(threadId, false), [source, threadId]);

  /** Dragging the bar moves it; dragging the corner resizes it (the right edge stays). */
  const gesture = (kind: "move" | "resize") => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, geometry };
    let last = geometry;
    const move = (moved: globalThis.PointerEvent) => {
      const dx = moved.clientX - start.x;
      const dy = moved.clientY - start.y;
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
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      save(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const height = Math.round(geometry.width * aspect);
  return createPortal(
    <section
      aria-label={`Picture in picture: ${props.page.title}`}
      data-browser-pip=""
      style={{ right: geometry.right, bottom: geometry.bottom, width: geometry.width }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-lg ace-floating-solid shadow-glass"
    >
      <div
        onPointerDown={gesture("move")}
        className="flex h-7 shrink-0 cursor-grab items-center gap-1 pr-0.5 pl-1 active:cursor-grabbing"
      >
        <button
          type="button"
          onClick={props.onRestore}
          aria-label={`Show ${props.page.title} in the panel`}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left text-xs text-muted-foreground focus-ring hover:text-foreground"
        >
          {props.page.favicon ? (
            <img
              src={props.page.favicon}
              alt=""
              aria-hidden
              className="size-3.5 shrink-0 rounded-xs"
            />
          ) : (
            <GlobeSimpleIcon aria-hidden size={14} className="shrink-0" />
          )}
          <span className="min-w-0 truncate">{props.page.title}</span>
        </button>
        <IconButton
          size="sm"
          icon={ArrowsOutSimpleIcon}
          label="Show in the panel"
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
