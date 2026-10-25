import type { DeviceChrome, DeviceChromeButton, DeviceChromeRect } from "@ace/protocol";
import type { DeviceKind } from "./device-catalog.ts";
import type { Edge, HardwareKey, Turn } from "./device-buttons.ts";
import type { Size } from "./device-frame-geometry.ts";

/*
 * Drawing a device's real look (`DeviceChrome`, from the SDK on the daemon's machine) around its
 * live picture: how big, where the screen lands once the body is turned, and what each of its
 * buttons presses. Pure: the frame component only places what this returns.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ChromeLayout {
  /** The turned body's box, in CSS pixels. */
  box: Size;
  /**
   * The upright body inside `box`: drawn at this size and position, then turned `turn` degrees
   * about its centre. Body art, the notch and the buttons go here, in upright body units
   * multiplied by `scale`.
   */
  plate: Box;
  /** CSS pixels per body unit, across and down (down differs when the picture is a little taller). */
  scale: { x: number; y: number };
  /** The screen, unturned, in the box: the live picture fills it. */
  screen: Box;
}

/** A picture whose shape is further than this from the chrome's screen gets the drawn frame. */
const aspectTolerance = 0.05;

const sideways = (turn: Turn) => turn === 90 || turn === 270;

/**
 * Where the chrome and the picture go in `room`, with the body turned `turn` degrees clockwise.
 * `picture` is the live picture's size in points as shown (already turned). Undefined when the
 * chrome's screen isn't the picture's shape, so the caller draws its own frame instead. Never
 * larger than one CSS pixel per point of the picture.
 */
export function chromeLayout(
  chrome: DeviceChrome,
  turn: Turn,
  picture: Size,
  room: Size,
): ChromeLayout | undefined {
  const upright = sideways(turn) ? { width: picture.height, height: picture.width } : picture;
  if (!(upright.width > 0 && upright.height > 0 && room.width > 0 && room.height > 0))
    return undefined;
  const { screen, body } = chrome;
  // Stretch the body's height slightly when the skin's display is a touch shorter or taller
  // than the device's (an emulator skin made for a sibling model).
  const stretch = upright.height / upright.width / (screen.height / screen.width);
  if (Math.abs(stretch - 1) > aspectTolerance) return undefined;
  const bodyHeight = body.height * stretch;
  const turned = sideways(turn)
    ? { width: bodyHeight, height: body.width }
    : { width: body.width, height: bodyHeight };
  const unit = Math.min(
    room.width / turned.width,
    room.height / turned.height,
    upright.width / screen.width,
  );
  const scale = { x: unit, y: unit * stretch };
  const W = body.width * scale.x;
  const H = body.height * scale.y;
  const s = {
    x: screen.x * scale.x,
    y: screen.y * scale.y,
    width: screen.width * scale.x,
    height: screen.height * scale.y,
  };
  const box = { width: turned.width * unit, height: turned.height * unit };
  const screenBox =
    turn === 90
      ? { left: H - s.y - s.height, top: s.x, width: s.height, height: s.width }
      : turn === 180
        ? { left: W - s.x - s.width, top: H - s.y - s.height, width: s.width, height: s.height }
        : turn === 270
          ? { left: s.y, top: W - s.x - s.width, width: s.height, height: s.width }
          : { left: s.x, top: s.y, width: s.width, height: s.height };
  return {
    box,
    plate: { left: (box.width - W) / 2, top: (box.height - H) / 2, width: W, height: H },
    scale,
    screen: screenBox,
  };
}

/** A rectangle in upright body units, in the plate's CSS pixels. */
export function plateBox(rect: DeviceChromeRect, scale: { x: number; y: number }): Box {
  return {
    left: rect.x * scale.x,
    top: rect.y * scale.y,
    width: rect.width * scale.x,
    height: rect.height * scale.y,
  };
}

/**
 * An upright image turned `turn` degrees clockwise, as an SVG data URL of the turned size, for
 * what can't be turned with CSS (the screen's mask). Unturned, the image itself.
 */
export function turnedImage(url: string, size: Size, turn: Turn): string {
  if (turn === 0) return url;
  const { width: w, height: h } = size;
  const view = sideways(turn) ? `0 0 ${h} ${w}` : `0 0 ${w} ${h}`;
  const move =
    turn === 90 ? `translate(${h} 0)` : turn === 180 ? `translate(${w} ${h})` : `translate(0 ${w})`;
  const href = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" preserveAspectRatio="none"><image href="${href}" width="${w}" height="${h}" preserveAspectRatio="none" transform="${move} rotate(${turn})"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const keys: Record<string, HardwareKey> = {
  action: "action",
  "volume-up": "volumeUp",
  "volume-down": "volumeDown",
  power: "power",
  home: "home",
  // Pressing the Digital Crown is the watch's Home.
  "digital-crown": "home",
  "side-button": "side",
};

/** The key a chrome button presses; none when ace can't press it (a ring switch). */
export function chromeButtonKey(button: Pick<DeviceChromeButton, "name">): HardwareKey | undefined {
  return Object.hasOwn(keys, button.name) ? keys[button.name] : undefined;
}

const labels: Record<string, string> = {
  action: "Action button",
  "volume-up": "Volume up",
  "volume-down": "Volume down",
  home: "Home button",
  mute: "Ring/Silent switch",
  "digital-crown": "Digital Crown",
  "side-button": "Side button",
};

/** A chrome button's accessible name and tooltip. */
export function chromeButtonLabel(
  button: Pick<DeviceChromeButton, "name" | "title">,
  kind: DeviceKind,
): string {
  if (button.name === "power") return kind === "ipad" ? "Top button" : "Side button";
  return (
    (Object.hasOwn(labels, button.name) ? labels[button.name] : undefined) ??
    button.title ??
    button.name
  );
}

const clockwise: Edge[] = ["top", "right", "bottom", "left"];

/** The side of the turned body a button stands out from, where its tooltip opens. */
export function chromeButtonEdge(
  button: Pick<DeviceChromeButton, "rect">,
  body: Size,
  turn: Turn,
): Edge {
  const { x, y, width, height } = button.rect;
  const middle = { x: x + width / 2, y: y + height / 2 };
  const upright: Edge =
    middle.x <= 0 ? "left" : middle.x >= body.width ? "right" : middle.y <= 0 ? "top" : "bottom";
  return clockwise[(clockwise.indexOf(upright) + turn / 90) % 4] ?? upright;
}
