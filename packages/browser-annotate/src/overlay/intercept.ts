export interface InterceptHandlers {
  /** A trusted primary click on the page (never on the overlay). */
  pick(x: number, y: number): void;
  hover(x: number, y: number): void;
  /** The pointer left the page or moved onto the overlay. */
  leave(): void;
  /** Keyboard, text and focus events inside the overlay, before any page listener sees them. */
  ui(event: Event): void;
  /** Escape pressed while focus is on the page. */
  escape(): void;
}

/** Pointer activation the page never receives while annotating. Wheel is never touched. */
const swallowed = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
  "dragstart",
  "selectstart",
] as const;
/** Overlay editing the page must not observe: its shortcuts could otherwise eat keystrokes. */
const contained = [
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "paste",
  "copy",
  "cut",
  "focusin",
  "focusout",
] as const;

/** Holding Space hands the page back for a moment, unless it is typed into a field. */
const holdsSpace = (event: KeyboardEvent) =>
  event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey;
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Capture-phase listeners on `window`, the earliest point an isolated world can reach after the
 * page has loaded. Synthetic events (`isTrusted === false`) are the page's own business and pass
 * untouched; only real input from the person is redirected. While the person holds Space, the
 * page gets its input back (to scroll a carousel, open a menu) and annotating resumes on release.
 */
export function intercept(host: Element, handlers: InterceptHandlers): () => void {
  const inside = (event: Event) => event.composedPath().includes(host);
  let passing = false;
  const pass = (on: boolean) => {
    if (passing === on) return;
    passing = on;
    document.adoptedStyleSheets = on
      ? document.adoptedStyleSheets.filter((sheet) => sheet !== frames)
      : [...document.adoptedStyleSheets, frames];
    if (on) handlers.leave();
  };
  const onSpace = (event: KeyboardEvent) => {
    if (!event.isTrusted || inside(event) || !holdsSpace(event) || editable(event.target)) return;
    // The page never sees the Space itself: holding it must not scroll or press a button.
    event.preventDefault();
    event.stopImmediatePropagation();
    pass(event.type === "keydown");
  };
  const onBlur = () => pass(false);
  const onPointer = (event: Event) => {
    if (!event.isTrusted || inside(event) || passing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "click" && event instanceof MouseEvent && event.button === 0)
      handlers.pick(event.clientX, event.clientY);
  };
  const onContained = (event: Event) => {
    if (!event.isTrusted) return;
    if (!inside(event)) {
      if (event instanceof KeyboardEvent && event.type === "keydown" && event.key === "Escape")
        handlers.escape();
      return;
    }
    handlers.ui(event);
    event.stopImmediatePropagation();
  };
  const onMove = (event: PointerEvent) => {
    if (!event.isTrusted || passing) return;
    if (inside(event)) handlers.leave();
    else handlers.hover(event.clientX, event.clientY);
  };
  const onOut = (event: PointerEvent) => {
    if (event.isTrusted && !event.relatedTarget) handlers.leave();
  };
  // Embedded documents receive their own input, out of this world's reach. While annotating,
  // pointer input goes to the embedding element instead, so a click pins the frame itself.
  const frames = new CSSStyleSheet();
  frames.replaceSync("iframe, frame, embed, object { pointer-events: none !important; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, frames];
  const options = { capture: true, passive: false } as const;
  window.addEventListener("keydown", onSpace, options);
  window.addEventListener("keyup", onSpace, options);
  window.addEventListener("blur", onBlur);
  for (const type of swallowed) window.addEventListener(type, onPointer, options);
  for (const type of contained) window.addEventListener(type, onContained, options);
  window.addEventListener("pointermove", onMove, { capture: true, passive: true });
  document.addEventListener("pointerout", onOut, { capture: true, passive: true });
  return () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== frames);
    window.removeEventListener("keydown", onSpace, options);
    window.removeEventListener("keyup", onSpace, options);
    window.removeEventListener("blur", onBlur);
    for (const type of swallowed) window.removeEventListener(type, onPointer, options);
    for (const type of contained) window.removeEventListener(type, onContained, options);
    window.removeEventListener("pointermove", onMove, { capture: true });
    document.removeEventListener("pointerout", onOut, { capture: true });
  };
}
