import { useRef, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { cn } from "@/lib/cn.ts";
import type { BrowserView, PreviewSource, ScreenFrame } from "../sources.ts";
import { useViewportSync } from "../preview/use-viewport-sync.ts";

/**
 * The page itself, edge to edge in the panel: the screencast frame on the panel's own surface,
 * never inside a pretend window. While this device holds control, pointer, wheel and keys go to
 * the page; otherwise it is a picture of what the agent sees. At "Fit the panel" the page is
 * sized to the pane so it renders 1:1; at a device size it is drawn whole, scaled to fit.
 */
export function PageView(props: {
  source: PreviewSource;
  threadId: string;
  view: BrowserView;
  frame: ScreenFrame;
  interactive: boolean;
  /** Follow the pane's size (responsive); false while a device size is set. */
  fit: boolean;
  /** Dimmed with a reason over it (offline, paused). */
  dimmed?: boolean;
}) {
  const { frame } = props;
  const pane = useRef<HTMLDivElement>(null);
  useViewportSync(props.source, props.threadId, pane, props.fit && props.interactive);
  // Pointer positions map back to page pixels through the picture's rendered box.
  const point = (event: MouseEvent<HTMLElement>) => {
    const box = event.currentTarget.querySelector("img")?.getBoundingClientRect();
    const scale = box?.width ? frame.width / box.width : 1;
    return {
      x: Math.round((event.clientX - (box?.left ?? 0)) * scale),
      y: Math.round((event.clientY - (box?.top ?? 0)) * scale),
    };
  };
  const send = (event: "mousePressed" | "mouseReleased") => (mouse: MouseEvent<HTMLElement>) => {
    if (mouse.button !== 0) return;
    props.source.input(props.threadId, { kind: "mouse", event, ...point(mouse) });
  };
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    props.source.input(props.threadId, {
      kind: "scroll",
      ...point(event),
      deltaX: Math.round(event.deltaX),
      deltaY: Math.round(event.deltaY),
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // App shortcuts (⌘L, ⌘R, tab switching) stay with ace.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Tab" && event.shiftKey) return;
    event.preventDefault();
    props.source.input(props.threadId, {
      kind: "key",
      event: "keyDown",
      key: event.key,
      ...(event.key.length === 1 ? { text: event.key } : {}),
    });
  };
  const image = (
    <img
      src={frame.src}
      alt={`Live view of ${props.view.url}`}
      draggable={false}
      width={frame.width}
      height={frame.height}
      className={cn(
        "block h-auto max-h-full w-auto max-w-full object-contain transition-opacity duration-(--dur-2)",
        !props.fit && "rounded-md shadow-[0_0_0_1px_var(--border),0_16px_48px_rgb(0_0_0/0.28)]",
        props.dimmed && "opacity-40",
      )}
    />
  );
  // A responsive page sits top-left like a browser's; a device-sized one is centred on the
  // panel's surface. Space a frame doesn't cover is the panel itself, not a frame colour.
  const className = cn(
    "absolute inset-0 flex overflow-hidden",
    props.fit ? "items-start justify-start" : "items-center justify-center p-6",
  );
  return props.interactive ? (
    <div
      ref={pane}
      role="application"
      aria-label={`Control ${props.view.url}`}
      aria-roledescription="Live page"
      tabIndex={0}
      onMouseDown={send("mousePressed")}
      onMouseUp={send("mouseReleased")}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      className={cn(
        className,
        "cursor-default outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]",
      )}
    >
      {image}
    </div>
  ) : (
    <div ref={pane} className={className}>
      {image}
    </div>
  );
}
