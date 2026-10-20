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
