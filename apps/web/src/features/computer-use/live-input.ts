import { ScreenKey, type ScreenInput } from "@ace/protocol";

/** Where the picture sits in its element (drawn `object-contain`) and what it shows. */
export interface ShownPicture {
  /** The element's box on the page. */
  box: { left: number; top: number; width: number; height: number };
  /** The picture's pixels, and its pixels per point of the window. */
  width: number;
  height: number;
  scale: number;
}

/**
 * A page point over a live view as a point of the shared window (in its points, from its top
 * left), or undefined over the letterbox around the picture.
 */
export function windowPoint(
  page: { x: number; y: number },
  shown: ShownPicture,
): { x: number; y: number } | undefined {
  const { box } = shown;
  if (!shown.width || !shown.height || !box.width || !box.height) return undefined;
  const fit = Math.min(box.width / shown.width, box.height / shown.height);
  const left = box.left + (box.width - shown.width * fit) / 2;
  const top = box.top + (box.height - shown.height * fit) / 2;
  const px = (page.x - left) / fit;
  const py = (page.y - top) / fit;
  if (px < 0 || py < 0 || px >= shown.width || py >= shown.height) return undefined;
  const scale = shown.scale > 0 ? shown.scale : 1;
  return { x: px / scale, y: py / scale };
}

/** Farther than this (page pixels) between press and release is a drag, not a click. */
const dragSlop = 6;

/** A press and release on the picture as a click or a drag of the window. */
export function pointerGesture(
  down: { page: { x: number; y: number }; at: { x: number; y: number }; button: number },
  up: { page: { x: number; y: number }; at: { x: number; y: number } | undefined },
  durationMs: number,
): ScreenInput | undefined {
  const button = down.button === 2 ? "right" : "left";
  const moved = Math.hypot(up.page.x - down.page.x, up.page.y - down.page.y) > dragSlop;
  if (!moved || !up.at) return { kind: "pointer.click", ...down.at, button };
  return {
    kind: "pointer.drag",
    ...down.at,
    toX: up.at.x,
    toY: up.at.y,
    button,
    durationMs: Math.max(1, Math.min(10_000, Math.round(durationMs))),
  };
}

const named: Record<string, ScreenKey> = {
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Escape: "Escape",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
};

/**
 * A key the person pressed over a live view as input for the window: printable characters
 * are typed, named keys and shortcuts pressed. Undefined for keys that stay with the page
 * (modifiers alone, keys the window can't be sent).
 */
export function keyInput(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): ScreenInput | undefined {
  const modifiers = [
    ...(event.ctrlKey ? (["control"] as const) : []),
    ...(event.altKey ? (["alt"] as const) : []),
    ...(event.metaKey ? (["super"] as const) : []),
  ];
  const name = named[event.key] ?? (/^F\d{1,2}$/.test(event.key) ? event.key : undefined);
  if (name) {
    const key = ScreenKey.safeParse(name);
    const all = event.shiftKey ? [...modifiers, "shift" as const] : modifiers;
    return key.success ? { kind: "key.press", key: key.data, modifiers: all } : undefined;
  }
  if ([...event.key].length !== 1) return undefined;
  if (!modifiers.length) return { kind: "text.type", text: event.key };
  const key = ScreenKey.safeParse(event.key === " " ? "Space" : event.key);
  return key.success ? { kind: "key.press", key: key.data, modifiers } : undefined;
}
