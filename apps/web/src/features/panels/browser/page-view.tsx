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
import { PageContextMenu, type PageMenu } from "./page-context-menu.tsx";
import { typedByPageKeyboard } from "./page-keyboard.tsx";
import { PageStateLayer } from "./page-state-layer.tsx";
import { usePageState } from "./use-page-state.ts";
import { mouseButton, mouseMove, modifierMask } from "./pointer-input.ts";
import { localCursor } from "./local-echo.ts";
import { useLocalEcho } from "./use-local-echo.ts";
import { LocalEchoOverlay } from "./local-echo-overlay.tsx";
import { useTouchInput, useTouchScreen } from "./use-touch-input.ts";

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
  /** Drawn inside the device toolbar's frame, which it fills exactly. */
  framed?: boolean;
  /** The tab's zoom: the page is that much smaller in CSS pixels, drawn back at the pane's size. */
  zoom?: number | undefined;
  /** The right-click menu; without it, a right click goes to the page. */
  menu?: PageMenu | undefined;
  /** Dimmed with a reason over it (offline, paused). */
  dimmed?: boolean;
  /** The page's cursor shape under the person's pointer (a CSS keyword); the arrow if absent. */
  cursor?: string | undefined;
}) {
  const { frame } = props;
  const tabId = props.tab?.tabId;
  const pane = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const echo = useLocalEcho(props.threadId, frame);
  /** The person's input, to the shown tab by name, timed for the ⋯ menu's round trip. */
  const forward = (input: ForwardedInput) =>
    echo.timed(() => props.source.input(props.threadId, input, tabId));
  const keymap = useResolvedKeymap();
  /** The focused field, picker, cursor shape and tooltip the page reports for this tab. */
  const page = usePageState(props.source, props.threadId, tabId);
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
  const touchScreen = useTouchScreen();
  useViewportSync(props.source, props.threadId, pane, props.fit && props.interactive, touchScreen);
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
    // A right click opens ace's menu; with ⇧ it goes to the page (its own menus).
    if (mouse.button === 2 && props.menu && !mouse.shiftKey) return;
    const input = mouseButton(event, point(mouse), mouse);
    if (!input) return;
    if (event === "mousePressed") {
      mouse.currentTarget.focus();
      const box = mouse.currentTarget.getBoundingClientRect();
      echo.ripple(mouse.clientX - box.left, mouse.clientY - box.top);
    }
    void forward(input);
  };
  const move = useRef<ForwardedInput | undefined>(undefined);
  const scheduledMove = useRef(0);
  useEffect(() => () => cancelAnimationFrame(scheduledMove.current), []);
  const onMove = (event: MouseEvent<HTMLElement>) => {
    move.current = mouseMove(point(event), event);
    if (!scheduledMove.current)
      scheduledMove.current = requestAnimationFrame(() => {
        scheduledMove.current = 0;
        if (move.current) void forward(move.current);
      });
  };
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    const deltaX = Math.round(event.deltaX);
    const deltaY = Math.round(event.deltaY);
    const sent = forward({
      kind: "scroll",
      ...point(event),
      deltaX,
      deltaY,
      modifiers: modifierMask(event),
    });
    // Ctrl+wheel is a pinch or the page's zoom, not a scroll to show ahead of the frame.
    if (!event.ctrlKey) echo.scroll(deltaX, deltaY, sent);
  };
  const touch = useTouchInput({
    locate: (event) => point(event),
    send: forward,
    echo,
    onLongPress: props.menu ? (at) => props.menu?.locate(at) : undefined,
  });
  const onKey = (type: "keyDown" | "keyUp") => (event: KeyboardEvent<HTMLElement>) => {
    // Text the page keyboard types (an IME, a dead key, a phone's letters) goes as text.
    if (typedByPageKeyboard(event)) return;
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
  // A zoomed page is smaller in CSS pixels; drawn at its zoomed size it fills the pane again.
  const zoom = props.zoom ?? 1;
  const image = !props.nativeShown && (
    <img
      ref={picture}
      src={frame.src}
      alt={`Live view of ${props.view.url}`}
      draggable={false}
      style={echo.pictureStyle}
      width={Math.round(frame.width * zoom)}
      height={Math.round(frame.height * zoom)}
      className={cn(
        "block object-contain transition-opacity duration-(--motion-base)",
        props.framed ? "size-full" : "h-auto max-h-full w-auto max-w-full",
        !props.fit && !props.framed && "rounded-md shadow-glass",
        props.dimmed && "opacity-40",
      )}
    />
  );
  // A responsive page sits top-left like a browser's; a device-sized one is centred on the
  // panel's surface. Space a frame doesn't cover is the panel itself, not a frame colour.
  const className = cn(
    "absolute inset-0 flex overflow-hidden",
    props.fit || props.framed ? "items-start justify-start" : "items-center justify-center p-6",
  );
  // One element whether or not the page takes input now, so focus stays on it when control or
  // annotate mode changes hands: dropped to <body>, the composer would take the next keys and
  // Enter would send it. While the page can't take them, keys typed here go nowhere.
  const live = props.interactive && !props.nativeShown;
  // The daemon draws agents' cursors in the page, so the frames already show them; only a
  // recording keeps them out of the page, and then they are drawn here instead.
  const inPage = props.view.features?.includes("page-cursor") === true && !props.view.recording;
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
  const view = (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- handlers attach only while live, when the pane is role="application"
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
      onPointerDown={live ? touch.onPointerDown : undefined}
      onPointerMove={live ? touch.onPointerMove : undefined}
      onPointerUp={live ? touch.onPointerUp : undefined}
      onPointerCancel={live ? touch.onPointerCancel : undefined}
      onContextMenu={
        !live
          ? undefined
          : props.menu
            ? (event) => props.menu?.locate(point(event))
            : (event) => event.preventDefault()
      }
      onKeyDown={live ? onKey("keyDown") : undefined}
      onKeyUp={live ? onKey("keyUp") : undefined}
      onPaste={live ? paste : undefined}
      style={live ? { cursor: localCursor(props.cursor) } : undefined}
      className={cn(
        className,
        "outline-none",
        // Gestures go to the page, never pan or zoom ace, and a long press is the page's.
        live && "touch-none select-none focus-ring-inset [-webkit-touch-callout:none]",
      )}
    >
      {image}
      {image && live && <LocalEchoOverlay ripples={echo.ripples} onSettled={echo.settled} />}
      {image && props.tab?.inUse && props.tab.pointer && !inPage && (
        <AgentCursor
          threadId={props.threadId}
          agentId={props.tab.inUse.agentId}
          pointer={props.tab.pointer}
          page={{ width: frame.width, height: frame.height }}
          picture={picture}
        />
      )}
      {image && live && (
        <PageStateLayer
          page={page}
          pane={pane}
          picture={picture}
          frame={frame}
          forward={(input) => void forward(input)}
        />
      )}
    </div>
  );
  return props.menu && live ? <PageContextMenu menu={props.menu}>{view}</PageContextMenu> : view;
}
