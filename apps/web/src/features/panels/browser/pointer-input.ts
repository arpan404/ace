import type { ForwardedInput } from "../sources.ts";
export {
  TouchGestures,
  longPressDelay,
  touchSlop,
  type PointerAt,
  type TouchEffect,
} from "@/lib/touch-gestures.ts";

/**
 * The person's pointer on the live page, as the input the page gets: mouse buttons and held
 * keys for a mouse or pen, and touches for fingers. Pure: no DOM, no clock, no timers. The
 * shell (`use-touch-input.ts`) feeds it events and times, and acts on what it returns.
 */

/** Keys held during an event, as the DOM reports them. */
export interface HeldKeys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** CDP's modifier mask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifierMask(keys: HeldKeys): number {
  return (
    (keys.altKey ? 1 : 0) |
    (keys.ctrlKey ? 2 : 0) |
    (keys.metaKey ? 4 : 0) |
    (keys.shiftKey ? 8 : 0)
  );
}

type MouseButton = "none" | "left" | "middle" | "right";

/** The DOM's `button` (0 left, 1 middle, 2 right) by name; back and forward aren't sent. */
export function buttonName(button: number): MouseButton | undefined {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : undefined;
}

/**
 * A mouse move with what is held: the first of left, right and middle names the button, and the
 * whole mask goes as `buttons` (the DOM's mask is CDP's: left 1, right 2, middle 4).
 */
export function mouseMove(
  page: { x: number; y: number },
  event: HeldKeys & { buttons: number },
): ForwardedInput {
  const buttons = event.buttons & 7;
  return {
    kind: "mouse",
    event: "mouseMoved",
    ...page,
    button: buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none",
    buttons,
    modifiers: modifierMask(event),
  };
}

/** A press or release of one button, with the buttons still held and the keys. */
export function mouseButton(
  type: "mousePressed" | "mouseReleased",
  page: { x: number; y: number },
  event: HeldKeys & { button: number; buttons: number; detail: number },
): ForwardedInput | undefined {
  const button = buttonName(event.button);
  if (!button) return undefined;
  return {
    kind: "mouse",
    event: type,
    ...page,
    button,
    buttons: event.buttons & 7,
    clickCount: Math.min(3, Math.max(1, event.detail)),
    modifiers: modifierMask(event),
  };
}

/** One wheel line in CSS pixels, about what Chromium scrolls for a line. */
const wheelLine = 40;
/** Largest scroll one input may carry (the protocol's coordinate bound). */
const wheelLimit = 100_000;

/**
 * A wheel event's scroll as the page should get it, in its CSS pixels. Pixel deltas (a trackpad,
 * most mice) are the panel's pixels: `scale` (page pixels per panel pixel) turns them into the
 * page's, so a scaled-down page still moves with the fingers. Line and page steps become pixels.
 * Nothing is rounded, so a trackpad's small steps add up instead of vanishing.
 */
export function wheelScroll(
  wheel: { deltaX: number; deltaY: number; deltaMode: number },
  scale: number,
  page: { width: number; height: number },
): { deltaX: number; deltaY: number } {
  const step =
    wheel.deltaMode === 1
      ? { x: wheelLine, y: wheelLine }
      : wheel.deltaMode === 2
        ? { x: page.width, y: page.height }
        : { x: scale, y: scale };
  return { deltaX: bound(wheel.deltaX * step.x), deltaY: bound(wheel.deltaY * step.y) };
}

function bound(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  // `|| 0` folds -0 into 0.
  return Math.min(wheelLimit, Math.max(-wheelLimit, delta)) || 0;
}
