import type { DeviceInput } from "@ace/protocol";
import { iphoneCutout, iphoneHasActionButton, type DeviceKind } from "./device-catalog.ts";
import type { Size } from "./device-frame-geometry.ts";

/*
 * The hardware buttons on a device's sides, where the real device has them, and where they end
 * up when the device is turned. Pure: the frame only multiplies these out.
 */

export type HardwareKey = Extract<DeviceInput, { kind: "key" }>["key"];
export type Edge = "top" | "right" | "bottom" | "left";
/** Degrees clockwise the device's body is turned from upright. */
export type Turn = 0 | 90 | 180 | 270;

export interface HardwareButton {
  /** Its name: the accessible name and tooltip of a button that presses. */
  label: string;
  /** The key a press sends; none when ace can't press it, so it's drawn only. */
  key?: HardwareKey;
  edge: Edge;
  /** Where it starts along its edge (top to bottom, or left to right), as a fraction of it. */
  start: number;
  /** Its length along the edge, as a fraction of the edge. */
  length: number;
  /** How far it stands out from the body, as a fraction of the screen's width. */
  depth: number;
}

type Placed = Omit<HardwareButton, "label" | "key">;
const on = (edge: Edge, start: number, length: number, depth: number): Placed => ({
  edge,
  start,
  length,
  depth,
});

/** An upright device's buttons, as fractions of its body's edges. */
function uprightButtons(kind: DeviceKind, name: string): HardwareButton[] {
  switch (kind) {
    case "iphone": {
      const depth = 0.012;
      if (iphoneCutout(name) === "none")
        return [
          { label: "Ring/Silent switch", ...on("left", 0.135, 0.042, depth) },
          { label: "Volume up", key: "volumeUp", ...on("left", 0.222, 0.08, depth) },
          { label: "Volume down", key: "volumeDown", ...on("left", 0.318, 0.08, depth) },
          { label: "Side button", key: "power", ...on("right", 0.222, 0.08, depth) },
        ];
      return [
        iphoneHasActionButton(name)
          ? { label: "Action button", key: "action", ...on("left", 0.18, 0.036, depth) }
          : { label: "Ring/Silent switch", ...on("left", 0.18, 0.036, depth) },
        { label: "Volume up", key: "volumeUp", ...on("left", 0.245, 0.08, depth) },
        { label: "Volume down", key: "volumeDown", ...on("left", 0.335, 0.08, depth) },
        { label: "Side button", key: "power", ...on("right", 0.29, 0.13, depth) },
      ];
    }
    case "ipad":
      return [
        { label: "Top button", key: "power", ...on("top", 0.82, 0.056, 0.008) },
        { label: "Volume up", key: "volumeUp", ...on("right", 0.068, 0.035, 0.008) },
        { label: "Volume down", key: "volumeDown", ...on("right", 0.11, 0.035, 0.008) },
      ];
    case "watch":
      // Pressing the Digital Crown is the watch's Home.
      return [
        { label: "Digital Crown", key: "home", ...on("right", 0.26, 0.144, 0.045) },
        { label: "Side button", key: "side", ...on("right", 0.56, 0.187, 0.025) },
      ];
    case "android-phone":
      // Power above a volume rocker, both on the right edge.
      return [
        { label: "Power button", key: "power", ...on("right", 0.25, 0.065, 0.012) },
        { label: "Volume up", key: "volumeUp", ...on("right", 0.34, 0.075, 0.012) },
        { label: "Volume down", key: "volumeDown", ...on("right", 0.415, 0.075, 0.012) },
      ];
    case "android-tablet":
      return [
        { label: "Power button", key: "power", ...on("right", 0.08, 0.045, 0.008) },
        { label: "Volume up", key: "volumeUp", ...on("right", 0.15, 0.05, 0.008) },
        { label: "Volume down", key: "volumeDown", ...on("right", 0.2, 0.05, 0.008) },
      ];
    case "tv":
    case "vision":
      return [];
  }
}

/** Where an edge goes when the body turns a quarter clockwise, and whether its run reverses. */
const quarter: Record<Edge, { edge: Edge; reversed: boolean }> = {
  top: { edge: "right", reversed: false },
  right: { edge: "bottom", reversed: true },
  bottom: { edge: "left", reversed: false },
  left: { edge: "top", reversed: true },
};

function turnQuarter(button: HardwareButton): HardwareButton {
  const next = quarter[button.edge];
  return {
    ...button,
    edge: next.edge,
    start: next.reversed ? 1 - button.start - button.length : button.start,
  };
}

/** A device's side buttons with its body turned `turn` degrees clockwise. */
export function deviceButtons(kind: DeviceKind, name: string, turn: Turn): HardwareButton[] {
  let buttons = uprightButtons(kind, name);
  for (let step = 0; step < turn / 90; step++) buttons = buttons.map(turnQuarter);
  return buttons;
}

/**
 * How far the body is turned, from the upright picture's size and the turn the picture needed.
 * A Simulator's picture says its turn (90 when ace rotates it, to landscape left). Android's
 * picture arrives upright, so a landscape one is Android's first rotation: a quarter
 * anticlockwise.
 */
export function bodyTurn(platform: "ios" | "android", screen: Size, pictureTurn: number): Turn {
  if (pictureTurn === 90 || pictureTurn === 180 || pictureTurn === 270) return pictureTurn;
  if (screen.width <= screen.height) return 0;
  return platform === "ios" ? 90 : 270;
}
