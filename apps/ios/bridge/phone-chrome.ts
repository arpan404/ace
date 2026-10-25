import type { DeviceChrome } from "@ace/protocol";
import {
  chromeButtonKey,
  chromeButtonLabel,
  chromeLayout,
  type Box,
  type DeviceKind,
  type Size,
  type Turn,
} from "@ace/ui-core/devices";

/*
 * A device's real look (`DeviceChrome`, asked of the daemon as PNG) shaped for the phone with
 * the web's own layout (`chromeLayout`): where the body, its plate and the screen go for each
 * turn, in points at one point per device point. Swift scales it into its room and places the
 * images as sent. Pure.
 */

/** Where things go with the body turned a given way, in points. */
export interface PhoneChromeTurn {
  /** The turned body's box. */
  box: Size;
  /** The upright body inside the box, drawn here and then turned about its centre. */
  plate: Box;
  /** The screen, unturned, in the box. */
  screen: Box;
}

/** A rectangle as fractions of the upright body: left, top, width and height. */
export interface Fraction {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PhoneChrome {
  body: string;
  mask: string | null;
  cutout: { image: string; rect: Fraction } | null;
  buttons: {
    label: string;
    /** The key a press sends; empty for hardware ace can't press (a ring switch). */
    key: string;
    image: string;
    pressed: string | null;
    onTop: boolean;
    rect: Fraction;
  }[];
  /** Upright, then turned a quarter, a half and three quarters clockwise. */
  turns: PhoneChromeTurn[];
}

const turns: Turn[] = [0, 90, 180, 270];
/** Room too large to bind: each layout comes out at one point per device point. */
const unbounded = { width: 1e7, height: 1e7 };

/**
 * The look for the phone, or undefined when it doesn't fit the device's screen. `upright` is the
 * screen's size in points; the chrome's own screen sets its shape, so an emulator skin (in
 * pixels) comes out in points too.
 */
export function phoneChrome(
  chrome: DeviceChrome,
  kind: DeviceKind,
  upright: Size,
): PhoneChrome | undefined {
  const { body, screen } = chrome;
  const points = { width: upright.width, height: (upright.width * screen.height) / screen.width };
  const laid = turns.map((turn) => {
    const picture = turn % 180 ? { width: points.height, height: points.width } : points;
    return chromeLayout(chrome, turn, picture, unbounded);
  });
  const fraction = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: rect.x / body.width,
    y: rect.y / body.height,
    width: rect.width / body.width,
    height: rect.height / body.height,
  });
  const shaped: PhoneChromeTurn[] = [];
  for (const layout of laid) {
    if (!layout) return undefined;
    shaped.push({ box: layout.box, plate: layout.plate, screen: layout.screen });
  }
  return {
    body: body.image,
    mask: chrome.mask ?? null,
    cutout: chrome.cutout
      ? { image: chrome.cutout.image, rect: fraction(chrome.cutout.rect) }
      : null,
    buttons: chrome.buttons.map((button) => ({
      label: chromeButtonLabel(button, kind),
      key: chromeButtonKey(button) ?? "",
      image: button.image,
      pressed: button.pressed ?? null,
      onTop: button.onTop,
      rect: fraction(button.rect),
    })),
    turns: shaped,
  };
}
