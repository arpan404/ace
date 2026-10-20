import { between, type Box } from "./region.ts";

export interface InterceptHandlers {
  /** A trusted primary click on the page (never on the overlay) that was not a drag. */
  pick(x: number, y: number): void;
  hover(x: number, y: number): void;
  /** The pointer left the page or moved onto the overlay. */
  leave(): void;
  /** The area being dragged out, in viewport px; null when the drag was abandoned. */
  drag(box: Box | null): void;
  /** A drag on the page ended: the person selected the area between these viewport points. */
  region(start: { x: number; y: number }, end: { x: number; y: number }): void;
  /** Space is held (true) or released (false): the page takes pointer input meanwhile. */
  using(active: boolean): void;
  /** Keyboard, text and focus events inside the overlay, before any page listener sees them. */
  ui(event: Event): void;
  /** Escape pressed while focus is on the page. */
  escape(): void;
}

/** Movement in CSS px that turns a press into a drag; less is still a click. */
export const dragThreshold = 4;

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
/** The rest of a press that began while Space was held: it belongs to the page. */
const releases = new Set(["pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu"]);
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

const textInputs = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** Whether Space typed at `target` is text for the page rather than the hold gesture. */
function typing(target: EventTarget | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && textInputs.has(target.type);
}

function isSpace(event: KeyboardEvent): boolean {
  return (
    (event.code === "Space" || event.key === " ") &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

/**
 * Capture-phase listeners on `window`, the earliest point an isolated world can reach after the
 * page has loaded. Synthetic events (`isTrusted === false`) are the page's own business and pass
 * untouched; only real input from the person is redirected. A press that moves at least
 * `dragThreshold` px drags out a region instead of picking; holding Space lets pointer input
 * through to the page.
 */
export function intercept(host: Element, handlers: InterceptHandlers): () => void {
  const inside = (event: Event) => event.composedPath().includes(host);
  let press: { x: number; y: number; pointer: number } | undefined;
  let dragging = false;
  /** The click that ends a drag picks nothing. */
  let dragged = false;
  let using = false;
  /** A press began while Space was held; its release still goes to the page. */
  let passing = false;

  const cancelDrag = () => {
    if (dragging) handlers.drag(null);
    press = undefined;
    dragging = false;
  };
  const setUsing = (active: boolean) => {
    if (active === using) return;
    using = active;
    cancelDrag();
    frames.disabled = active;
    handlers.using(active);
  };
  const onPointer = (event: Event) => {
    if (!event.isTrusted) return;
    if (using) {
      if (event.type === "pointerdown") passing = true;
      return;
    }
    if (passing && releases.has(event.type)) {
      if (event.type !== "pointerup" && event.type !== "mouseup") passing = false;
      return;
    }
    if (event.type === "pointerup" && event instanceof PointerEvent) finishDrag(event);
    if (inside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "pointerdown" && event instanceof PointerEvent) {
      passing = false;
      dragged = false;
      if (event.button === 0 && event.isPrimary)
        press = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
    } else if (event.type === "click" && event instanceof MouseEvent && event.button === 0) {
      if (dragged) dragged = false;
      else handlers.pick(event.clientX, event.clientY);
    }
  };
  /** The press ends: a drag becomes a region; a press that never moved far waits for its click. */
  const finishDrag = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.pointer) return;
    const start = { x: press.x, y: press.y };
    const wasDragging = dragging;
    press = undefined;
    dragging = false;
    if (!wasDragging) return;
    dragged = true;
    handlers.region(start, { x: event.clientX, y: event.clientY });
  };
  const onContained = (event: Event) => {
    if (!event.isTrusted) return;
    if (event instanceof KeyboardEvent && !inside(event) && isSpace(event)) {
      // Space typed into a page field stays text; releasing ends the hold wherever focus is.
      const releasing = event.type === "keyup" && using;
      if (releasing || using || !typing(event.composedPath()[0])) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === "keydown") setUsing(true);
        else if (event.type === "keyup") setUsing(false);
        return;
      }
    }
    if (!inside(event)) {
      if (event instanceof KeyboardEvent && event.type === "keydown" && event.key === "Escape") {
        cancelDrag();
        handlers.escape();
      }
      return;
    }
    handlers.ui(event);
    event.stopImmediatePropagation();
  };
  const onMove = (event: PointerEvent) => {
    if (!event.isTrusted || using) return;
    if (press && event.pointerId === press.pointer) {
      if (!(event.buttons & 1)) cancelDrag();
      else {
        const far = Math.hypot(event.clientX - press.x, event.clientY - press.y) >= dragThreshold;
        if (far) dragging = true;
        if (dragging) {
          handlers.drag(between(press, { x: event.clientX, y: event.clientY }));
          return;
        }
      }
    }
    if (inside(event)) handlers.leave();
    else handlers.hover(event.clientX, event.clientY);
  };
  const onOut = (event: PointerEvent) => {
    if (event.isTrusted && !event.relatedTarget && !press) handlers.leave();
  };
  const onCancel = (event: PointerEvent) => {
    if (event.isTrusted && press?.pointer === event.pointerId) cancelDrag();
  };
  const onBlur = () => {
    cancelDrag();
    setUsing(false);
  };
  // Embedded documents receive their own input, out of this world's reach. While annotating,
  // pointer input goes to the embedding element instead, so a click pins the frame itself.
  const frames = new CSSStyleSheet();
  frames.replaceSync("iframe, frame, embed, object { pointer-events: none !important; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, frames];
  const options = { capture: true, passive: false } as const;
  for (const type of swallowed) window.addEventListener(type, onPointer, options);
  for (const type of contained) window.addEventListener(type, onContained, options);
  window.addEventListener("pointermove", onMove, { capture: true, passive: true });
  window.addEventListener("pointercancel", onCancel, { capture: true, passive: true });
  window.addEventListener("blur", onBlur);
  document.addEventListener("pointerout", onOut, { capture: true, passive: true });
  return () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== frames);
    for (const type of swallowed) window.removeEventListener(type, onPointer, options);
    for (const type of contained) window.removeEventListener(type, onContained, options);
    window.removeEventListener("pointermove", onMove, { capture: true });
    window.removeEventListener("pointercancel", onCancel, { capture: true });
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("pointerout", onOut, { capture: true });
  };
}
