import { z } from "zod";

/*
 * A device's real hardware look, read at runtime from the SDK on the daemon's machine (Xcode's
 * Simulator device profiles, an Android emulator's skin): the body, where the screen sits in
 * it, the screen's exact shape, a notch drawn over the screen, and the side buttons. Every
 * length is in the body's own units (points for a Simulator, pixels for an emulator skin);
 * only proportions matter. Images are data URLs.
 */

const length = z.number().finite().min(-100_000).max(100_000);
const extent = z.number().finite().positive().max(100_000);
export const DeviceChromeRect = z.object({ x: length, y: length, width: extent, height: extent });
export type DeviceChromeRect = z.infer<typeof DeviceChromeRect>;

/** An SVG, WebP or PNG image as a base64 data URL. */
export const DeviceChromeImage = z
  .string()
  .max(1_000_000)
  .regex(/^data:image\/(?:svg\+xml|webp|png);base64,[A-Za-z0-9+/]+=*$/);
export type DeviceChromeImage = z.infer<typeof DeviceChromeImage>;

export const DeviceChromeButton = z.object({
  /** The SDK's own name for it: "volume-up", "power", "action", "home", "digital-crown". */
  name: z.string().min(1).max(64),
  /** Its human name: "Volume Up", "Sleep/Wake". */
  title: z.string().max(64).optional(),
  rect: DeviceChromeRect,
  image: DeviceChromeImage,
  /** The picture while pressed, when the SDK has one. */
  pressed: DeviceChromeImage.optional(),
  /** Drawn over the body (a home button on the face) rather than behind its edge. */
  onTop: z.boolean(),
});
export type DeviceChromeButton = z.infer<typeof DeviceChromeButton>;

export const DeviceChrome = z.object({
  /** The body's size and picture, the screen's hole included. */
  body: z.object({ width: extent, height: extent, image: DeviceChromeImage }),
  /** Where the screen sits in the body. */
  screen: DeviceChromeRect,
  /** The screen's exact shape (rounded corners, a punch hole), stretched over `screen`. */
  mask: DeviceChromeImage.optional(),
  /**
   * Hardware drawn over the screen that the picture doesn't show: an iPhone's notch, or an
   * emulator skin's rounded corners and camera hole.
   */
  cutout: z.object({ rect: DeviceChromeRect, image: DeviceChromeImage }).optional(),
  buttons: z.array(DeviceChromeButton).max(8),
});
export type DeviceChrome = z.infer<typeof DeviceChrome>;

/** The `chrome` operation's result: null when the SDK has no look for this device. */
export const DeviceChromeResult = z.object({ chrome: DeviceChrome.nullable() });
export type DeviceChromeResult = z.infer<typeof DeviceChromeResult>;
