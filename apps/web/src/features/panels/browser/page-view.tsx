import {
  useEffect,
  useMemo,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from "react";
import { matchesChord, parseChord } from "@/lib/hotkeys.ts";
import { bindingsFor, scopeOf, useResolvedKeymap } from "@/lib/keybindings.ts";
import { keymapIds } from "@/lib/keymap.ts";
import { cn } from "@/lib/cn.ts";
import type {
  BrowserTabView,
  BrowserView,
  ForwardedInput,
  PreviewSource,
  ScreenFrame,
} from "../sources.ts";
import { AgentCursor } from "./agent-cursor.tsx";
import { useCaptureSize } from "../preview/use-capture-size.ts";
import { useViewportSync } from "../preview/use-viewport-sync.ts";

/**
 * The page itself, edge to edge in the panel: the screencast frame on the panel's own surface,
 * never inside a pretend window. Pointer, wheel and keys go to the shown tab at once, whoever
 * else works in it; an agent working there shows as a cursor gliding to where it points. At
 * "Fit the panel" the page is sized to the pane so it renders 1:1; at a device size it is drawn
 * whole, scaled to fit.
 */
export function PageView(props: {
  source: PreviewSource;
  threadId: string;
  view: BrowserView;
  /** The tab shown: input goes to exactly this tab. */
  tab: BrowserTabView | undefined;
  frame: ScreenFrame;
  interactive: boolean;
  /** Native page acknowledged as visible; keep capture warm but do not paint a second copy. */
  nativeShown?: boolean;
  /** Follow the pane's size (responsive); false while a device size is set. */
  fit: boolean;
  /** Dimmed with a reason over it (offline, paused). */
  dimmed?: boolean;
}) {
  const { frame } = props;
  const tabId = props.tab?.tabId;
  /** The person's input, to the shown tab by name. */
  const forward = (input: ForwardedInput) => props.source.input(props.threadId, input, tabId);
  const pane = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const keymap = useResolvedKeymap();
  const appChords = useMemo(
    () =>
      keymapIds
        .filter((id) => scopeOf(id) === "global" || scopeOf(id) === "thread")
        .flatMap((id) => bindingsFor(id, keymap))
        .filter((binding) => !binding.includes(" "))
        .map(parseChord)
        .filter((chord) => chord.mod || chord.ctrl || chord.alt),
    [keymap],
  );
  useViewportSync(props.source, props.threadId, pane, props.fit && props.interactive);
  useCaptureSize(props.source, props.threadId, pane);
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
    if (mouse.button > 2) return;
    if (event === "mousePressed") mouse.currentTarget.focus();
    forward({
      kind: "mouse",
      event,
      ...point(mouse),
      button: mouse.button === 1 ? "middle" : mouse.button === 2 ? "right" : "left",
      clickCount: Math.max(1, mouse.detail),
    });
  };
  const move = useRef<ForwardedInput | undefined>(undefined);
  const scheduledMove = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scheduledMove.current), []);
  const onMove = (event: MouseEvent<HTMLElement>) => {
    move.current = {
      kind: "mouse",
      event: "mouseMoved",
      ...point(event),
      button: event.buttons & 1 ? "left" : "none",
    };
    if (!scheduledMove.current)
      scheduledMove.current = requestAnimationFrame(() => {
        scheduledMove.current = 0;
        if (move.current) forward(move.current);
      });
  };
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    forward({
      kind: "scroll",
      ...point(event),
      deltaX: Math.round(event.deltaX),
      deltaY: Math.round(event.deltaY),
    });
  };
  const onKey = (type: "keyDown" | "keyUp") => (event: KeyboardEvent<HTMLElement>) => {
    // Toolbar and app chords are consumed by the ancestors. Editing chords reach the page.
    if (event.defaultPrevented || appChords.some((chord) => matchesChord(event.nativeEvent, chord)))
      return;
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === "v") return;
      if (key === "c" || key === "x") {
        event.preventDefault();
        if (type === "keyDown" && props.source.selection && navigator.clipboard)
          void props.source
            .selection(props.threadId, tabId)
            .then(async (text) => {
              if (!text) return;
              await navigator.clipboard.writeText(text);
              if (key === "x")
                for (const keyEvent of ["keyDown", "keyUp"] as const)
                  forward({
                    kind: "key",
                    event: keyEvent,
                    key: "Backspace",
                    code: "Backspace",
                  });
            })
            .catch(() => {});
        return;
      }
    }
    event.preventDefault();
    forward({
      kind: "key",
      event: type,
      key: event.key,
      code: event.code,
      modifiers:
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0),
      ...(type === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey
        ? { text: event.key }
        : {}),
    });
  };
  const image = !props.nativeShown && (
    <img
      ref={picture}
      src={frame.src}
      alt={`Live view of ${props.view.url}`}
      draggable={false}
      width={frame.width}
      height={frame.height}
      className={cn(
        "block h-auto max-h-full w-auto max-w-full object-contain transition-opacity duration-(--motion-base)",
        !props.fit && "rounded-md shadow-glass",
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
  // One element whether or not the page takes input now, so focus stays on it when control or
  // annotate mode changes hands: dropped to <body>, the composer would take the next keys and
  // Enter would send it. While the page can't take them, keys typed here go nowhere.
  const live = props.interactive && !props.nativeShown;
  const paste = (event: ClipboardEvent<HTMLElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text");
    void (async () => {
      for (let index = 0; index < Math.min(text.length, 65536); index += 256)
        await forward({
          kind: "key",
          event: "char",
          key: "Paste",
          text: text.slice(index, index + 256),
        });
    })();
  };
  return (
    <div
      ref={pane}
      data-page-view=""
      role={live ? "application" : undefined}
      aria-label={live ? `Control ${props.view.url}` : undefined}
      aria-roledescription={live ? "Live page" : undefined}
      tabIndex={live ? 0 : -1}
      onMouseMove={live ? onMove : undefined}
      onMouseDown={live ? send("mousePressed") : undefined}
      onMouseUp={live ? send("mouseReleased") : undefined}
      onWheel={live ? onWheel : undefined}
      onContextMenu={live ? (event) => event.preventDefault() : undefined}
      onKeyDown={live ? onKey("keyDown") : undefined}
      onKeyUp={live ? onKey("keyUp") : undefined}
      onPaste={live ? paste : undefined}
      className={cn(className, "outline-none", live && "cursor-default focus-ring-inset")}
    >
      {image}
      {image && props.tab?.inUse && props.tab.pointer && (
        <AgentCursor
          threadId={props.threadId}
          agentId={props.tab.inUse.agentId}
          pointer={props.tab.pointer}
          page={{ width: frame.width, height: frame.height }}
          picture={picture}
        />
      )}
    </div>
  );
}
