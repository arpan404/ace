import type { ForwardedInput } from "../sources.ts";

/**
 * The person's pointer on the live page, as the input the page gets: mouse buttons and held
 * keys for a mouse or pen, and touches for fingers. Pure: no DOM, no clock, no timers. The
 * shell (`use-touch-input.ts`) feeds it events and times, and acts on what it returns.
 */

/** A position in two spaces: the screen (CSS pixels, for slop and echo) and the page's. */
export interface PointerAt {
  screen: { x: number; y: number };
  page: { x: number; y: number };
}

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

/** What the shell does after a touch event. */
export type TouchEffect =
  /** Send this to the page. */
  | { type: "input"; input: ForwardedInput }
  /** A tap landed here: show it. */
  | { type: "tap"; at: PointerAt }
  /** One finger drags the page by this much since the last pan (screen and page pixels). */
  | { type: "pan"; screen: { x: number; y: number }; page: { x: number; y: number } }
  /** One finger held still long enough: the page's long press. */
  | { type: "longPress"; at: PointerAt };

/** Movement within this many screen pixels is still a tap or a long press, not a drag. */
export const touchSlop = 10;
/** How long a still finger waits before it is a long press (ms). */
export const longPressDelay = 500;
/** The page takes up to ten touch points. */
const maxPoints = 10;

type Phase = "idle" | "pressing" | "dragging" | "pinching" | "held";

interface Finger {
  /** The protocol's point id (0–9), stable while the finger is down. */
  slot: number;
  at: PointerAt;
}

/**
 * One touch sequence at a time, from the first finger down to the last one up. Every active
 * finger goes to the page as a touch point (the page's own gestures make the tap's click, the
 * drag's scroll, the pinch's zoom and the long press's menu), and the sequence is read as a
 * gesture for local echo: a tap, a one-finger drag, a pinch, or a long press.
 */
export class TouchGestures {
  private readonly fingers = new Map<number, Finger>();
  private phase: Phase = "idle";
  private start: { at: PointerAt; time: number } | undefined;
  private last: PointerAt | undefined;

  /** A finger touches down. `time` is in ms on any monotonic clock. */
  down(pointerId: number, at: PointerAt, time: number): TouchEffect[] {
    if (this.fingers.has(pointerId)) return [];
    const slot = this.freeSlot();
    if (slot === undefined) return [];
    this.fingers.set(pointerId, { slot, at });
    if (this.fingers.size === 1) {
      this.phase = "pressing";
      this.start = { at, time };
      this.last = at;
    } else this.phase = "pinching";
    return [this.send("touchStart")];
  }

  /** A finger moved. Unknown pointers (pressed before the view took input) are ignored. */
  move(pointerId: number, at: PointerAt): TouchEffect[] {
    const finger = this.fingers.get(pointerId);
    if (!finger) return [];
    finger.at = at;
    const effects: TouchEffect[] = [];
    if (this.phase === "pressing" && this.start && distance(this.start.at, at) > touchSlop)
      this.phase = "dragging";
    if (this.phase === "dragging" && this.last) {
      effects.push({
        type: "pan",
        screen: { x: at.screen.x - this.last.screen.x, y: at.screen.y - this.last.screen.y },
        page: { x: at.page.x - this.last.page.x, y: at.page.y - this.last.page.y },
      });
      this.last = at;
    }
    effects.push(this.send("touchMove"));
    return effects;
  }

  /** A finger lifted. The last one up ends the sequence; a short still press was a tap. */
  up(pointerId: number, at: PointerAt | undefined, time: number): TouchEffect[] {
    const finger = this.fingers.get(pointerId);
    if (!finger) return [];
    if (at) finger.at = at;
    this.fingers.delete(pointerId);
    // The page sees one finger leave as a move without it; touchEnd carries no points.
    if (this.fingers.size > 0) return [this.send("touchMove")];
    const tapped =
      this.phase === "pressing" &&
      this.start !== undefined &&
      time - this.start.time < longPressDelay;
    const effects: TouchEffect[] = [];
    if (tapped) effects.push({ type: "tap", at: finger.at });
    effects.push({ type: "input", input: { kind: "touch", event: "touchEnd", points: [] } });
    this.reset();
    return effects;
  }

  /** The browser took the touch back (a scroll of its own, a system gesture). */
  cancel(): TouchEffect[] {
    if (this.fingers.size === 0) return [];
    this.fingers.clear();
    this.reset();
    return [{ type: "input", input: { kind: "touch", event: "touchCancel", points: [] } }];
  }

  /**
   * Time has passed (the shell's long-press timer fired, or any later check): a single finger
   * still within the slop since `longPressDelay` is a long press, once per sequence.
   */
  elapsed(time: number): TouchEffect[] {
    if (this.phase !== "pressing" || !this.start || this.fingers.size !== 1) return [];
    if (time - this.start.time < longPressDelay) return [];
    this.phase = "held";
    const finger = [...this.fingers.values()][0];
    return finger ? [{ type: "longPress", at: finger.at }] : [];
  }

  /** Fingers on the page now. */
  get active(): number {
    return this.fingers.size;
  }

  private send(event: "touchStart" | "touchMove"): TouchEffect {
    const points = [...this.fingers.values()].map((finger) => ({
      x: finger.at.page.x,
      y: finger.at.page.y,
      id: finger.slot,
    }));
    return { type: "input", input: { kind: "touch", event, points } };
  }

  private freeSlot(): number | undefined {
    const used = new Set([...this.fingers.values()].map((finger) => finger.slot));
    for (let slot = 0; slot < maxPoints; slot++) if (!used.has(slot)) return slot;
    return undefined;
  }

  private reset(): void {
    this.phase = "idle";
    this.start = undefined;
    this.last = undefined;
  }
}

function distance(a: PointerAt, b: PointerAt): number {
  return Math.hypot(a.screen.x - b.screen.x, a.screen.y - b.screen.y);
}
