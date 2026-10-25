import type { DeviceKind } from "./device-catalog.ts";
import { ipadFace, iphoneFace, type AppleFace } from "./device-profiles.ts";

/*
 * The drawn hardware around a device's screen, in units of the screen's own width, and how big
 * to draw it in the room the stage has. Pure: the frame component only multiplies these out.
 *
 * Nothing is drawn over the screen: a Simulator's or emulator's own picture already shows what
 * the real device shows there, so islands, notches and camera holes are never painted on it.
 */

export interface Size {
  width: number;
  height: number;
}

export interface FrameGeometry {
  /** Hardware around the screen on each side, as a fraction of the screen's width. */
  bezel: { top: number; right: number; bottom: number; left: number };
  /** The screen's corner radius, as a fraction of its width. */
  screenRadius: number;
  /** The body's corner radius, as a fraction of the screen's width. */
  bodyRadius: number;
  /** The metal band at the body's edge, outside its black glass, as a fraction of the screen's width. */
  band: number;
  /** A round home button under the screen (older iPhones and iPads), in the bezel the bottom turned to. */
  homeButton: boolean;
}

/** A frame's size in points (input and geometry use points; frames carry pixels). */
export function framePoints(header: {
  width: number;
  height: number;
  scale?: number | undefined;
}): Size {
  const scale = header.scale ?? 1;
  return { width: header.width / scale, height: header.height / scale };
}

/** The screen size each kind assumes before its first frame arrives, in points. */
export const defaultScreens: Record<DeviceKind, Size> = {
  iphone: iphoneFace("").screen,
  ipad: ipadFace("").screen,
  watch: { width: 208, height: 248 },
  tv: { width: 1920, height: 1080 },
  vision: { width: 1920, height: 1080 },
  "android-phone": { width: 412, height: 915 },
  "android-tablet": { width: 800, height: 1280 },
};

/** The upright screen a device of this kind and name has, until its first picture says otherwise. */
export function deviceScreen(kind: DeviceKind, name: string): Size {
  if (kind === "iphone") return iphoneFace(name).screen;
  if (kind === "ipad") return ipadFace(name).screen;
  return defaultScreens[kind];
}

/** A face as fractions of the upright screen's width. */
interface Face {
  radius: number;
  side: number;
  chin: number;
  bodyRadius?: number | undefined;
  band: number;
  homeButton: boolean;
}

function appleFace(face: AppleFace, short: number, band: number): Face {
  return {
    radius: short > 0 ? face.cornerRadius / short : 0,
    side: face.side,
    chin: face.chin,
    bodyRadius: face.bodyRadius,
    band,
    homeButton: face.homeButton,
  };
}

const plain = (side: number, radius: number, band: number): Face => ({
  radius,
  side,
  chin: side,
  band,
  homeButton: false,
});

function faceOf(kind: DeviceKind, name: string, short: number): Face {
  switch (kind) {
    case "iphone":
      return appleFace(iphoneFace(name), short, 0.012);
    case "ipad":
      return appleFace(ipadFace(name), short, 0.006);
    case "watch":
      return plain(0.1, 0.22, 0.03);
    case "android-phone":
      return plain(0.035, 0.09, 0.01);
    case "android-tablet":
      return plain(0.045, 0.035, 0.006);
    case "tv":
    case "vision":
      return plain(0.012, 0.008, 0);
  }
}

/**
 * The frame for a device, upright or turned on its side, fitted to the picture's own size: the
 * screen's corners follow the model's display, the bezels its measured borders, and the body's
 * corners sit concentric around the screen's.
 */
export function frameGeometry(kind: DeviceKind, name: string, screen: Size): FrameGeometry {
  const landscape = screen.width > screen.height;
  const short = Math.min(screen.width, screen.height);
  const face = faceOf(kind, name, short);
  // Geometry is drawn against the screen's width; turned sideways, the short side leads.
  const k = landscape && screen.width > 0 ? screen.height / screen.width : 1;
  const across = face.side * k;
  const along = face.chin * k;
  return {
    bezel: landscape
      ? { top: across, right: along, bottom: across, left: along }
      : { top: along, right: across, bottom: along, left: across },
    screenRadius: face.radius * k,
    bodyRadius: (face.bodyRadius ?? face.radius + face.side) * k,
    band: face.band * k,
    homeButton: face.homeButton,
  };
}

/**
 * The body and screen sizes that fit the frame in `room`, keeping the screen's aspect. Never
 * larger than the screen drawn at one CSS pixel per point, so a small simulator isn't blown up.
 */
export function fitFrame(
  room: Size,
  geometry: FrameGeometry,
  screen: Size,
): { body: Size; screen: Size; unit: number } {
  const { bezel } = geometry;
  const units = {
    width: 1 + bezel.left + bezel.right,
    height: screen.height / screen.width + bezel.top + bezel.bottom,
  };
  const unit = Math.max(
    0,
    Math.min(room.width / units.width, room.height / units.height, screen.width),
  );
  return {
    unit,
    body: { width: units.width * unit, height: units.height * unit },
    screen: { width: unit, height: (screen.height / screen.width) * unit },
  };
}
