import { ArrowsOutSimpleIcon, GlobeSimpleIcon, XIcon } from "@phosphor-icons/react";
import { readJson, writeJson } from "@ace/ui-core";
import * as z from "zod/mini";
import { useEffect, useEffectEvent, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { desktopBrowserViews } from "@/boot/desktop-browser.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { useLayout } from "@/lib/layout.tsx";
import type { BrowserView, PreviewSource } from "../sources.ts";
import { useNativeView } from "./native-view.ts";
import { CoverPicture, useCoverStill } from "./cover-picture.tsx";
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
 * in the panel; only × puts it away. In the desktop app the page's own native view moves into
 * it, laid out at its panel size and scaled down, so it never reloads or reflows; elsewhere it
 * draws the live video.
 */
export function BrowserPip(props: {
  source: PreviewSource;
  threadId: string;
  view: BrowserView;
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

  const body = useRef<HTMLDivElement>(null);
  const native = !!desktopBrowserViews() && props.view.backend === "embedded";
  const placed = useNativeView(props.threadId, body, native, {
    device: size,
    padding: 0,
    picture: true,
  });
  const { source, threadId } = props;
  // The native page takes no clicks here: the desktop reports a click on it instead, and that
  // click brings the page back, as one on the drawn picture does.
  const restore = useEffectEvent(() => props.onRestore());
  useEffect(() => {
    if (!native) return;
    return desktopBrowserViews()?.onRestore((id) => {
      if (id === threadId) restore();
    });
  }, [native, threadId]);
  // Drawn from the live video in a browser, and in the desktop app while the native view is
  // out of the way (a menu or toast over the window): first its still, then the live pictures.
  const frame = props.source.frame(props.threadId);
  const still = useCoverStill(placed.frozen, frame);
  // The daemon's video is drawn here whenever the native view isn't.
  const drawnNatively = native && placed.shown;
  useEffect(() => source.nativeShown?.(threadId, drawnNatively), [source, threadId, drawnNatively]);

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
        ref={body}
        data-pip-page=""
        style={{ height }}
        className="relative cursor-pointer bg-background"
        onClick={props.onRestore}
      >
        {frame && !placed.shown && (!native || placed.frozen) && (
          <FramePicture
            frame={frame}
            alt={`Live view of ${props.page.url}`}
            className="absolute inset-0 size-full object-contain"
          />
        )}
        {still && <CoverPicture still={still} />}
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
