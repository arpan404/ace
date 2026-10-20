import { iphoneCutout, type DeviceKind } from "./device-catalog.ts";

/*
 * The drawn hardware around a device's screen, in units of the screen's own width, and how big
 * to draw it in the room the stage has. Pure: the frame component only multiplies these out.
 */

export interface Size {
  width: number;
  height: number;
}

export type Cutout =
  | { kind: "island"; width: number; height: number; top: number }
  | { kind: "notch"; width: number; height: number }
  | { kind: "punch"; size: number; top: number }
  | { kind: "none" };

export interface FrameGeometry {
  /** Hardware around the screen on each side, as a fraction of the screen's width. */
  bezel: { top: number; right: number; bottom: number; left: number };
  /** The screen's corner radius, as a fraction of its width. */
  screenRadius: number;
  /** The body's corner radius, as a fraction of the screen's width. */
  bodyRadius: number;
  cutout: Cutout;
  /** A round home button under the screen (older iPhones), in the bezel the bottom turned to. */
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
  iphone: { width: 393, height: 852 },
  ipad: { width: 1032, height: 1376 },
  watch: { width: 208, height: 248 },
  tv: { width: 1920, height: 1080 },
  vision: { width: 1920, height: 1080 },
  "android-phone": { width: 412, height: 915 },
  "android-tablet": { width: 800, height: 1280 },
};

const even = (value: number) => ({ top: value, right: value, bottom: value, left: value });

/** The frame for a kind of device, upright or turned on its side. */
export function frameGeometry(kind: DeviceKind, name: string, screen: Size): FrameGeometry {
  const landscape = screen.width > screen.height;
  // Geometry is drawn against the screen's width; turned sideways, the short side leads.
  const short = landscape ? screen.height / screen.width : 1;
  const plain = (bezel: number, screenRadius: number): FrameGeometry => ({
    bezel: even(bezel * short),
    screenRadius: screenRadius * short,
    bodyRadius: (screenRadius + bezel) * short,
    cutout: { kind: "none" },
    homeButton: false,
  });
  switch (kind) {
    case "iphone": {
      const cut = iphoneCutout(name);
      if (cut === "none") {
        // The home-button face: square screen corners, deep forehead and chin.
        const frame = plain(0.06, 0);
        return {
          ...frame,
          bezel: landscape
            ? { top: 0.06 * short, right: 0.2 * short, bottom: 0.06 * short, left: 0.2 * short }
            : { top: 0.24, right: 0.06, bottom: 0.24, left: 0.06 },
          bodyRadius: 0.16 * short,
          homeButton: true,
        };
      }
      const frame = plain(0.045, 0.14);
      if (landscape) return frame;
      return {
        ...frame,
        cutout:
          cut === "island"
            ? { kind: "island", width: 0.32, height: 0.094, top: 0.028 }
            : { kind: "notch", width: 0.54, height: 0.076 },
      };
    }
    case "ipad":
      return plain(0.05, 0.035);
    case "watch":
      return plain(0.1, 0.22);
    case "android-phone": {
      const frame = plain(0.035, 0.09);
      return landscape ? frame : { ...frame, cutout: { kind: "punch", size: 0.03, top: 0.025 } };
    }
    case "android-tablet":
      return plain(0.045, 0.035);
    case "tv":
    case "vision":
      return plain(0.012, 0.008);
  }
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
