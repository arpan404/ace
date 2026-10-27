/**
 * The browser's device toolbar model, shared by the web and the phone: device presets, the size a
 * tab shows, the arithmetic of the framed viewport (fit, rotate, drag a handle), and which device
 * a screen opening a tab shows. Pure, so it is tested without a page.
 */

/** A device the page can take, with what makes the page treat it as that device. */
export interface DevicePreset {
  id: string;
  label: string;
  kind: "phone" | "tablet" | "computer";
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
}

/** The size a tab shows in the device toolbar: a preset's, or any size ("responsive"). */
export interface DeviceSize {
  preset: string;
  width: number;
  height: number;
}

/** What the page is told it runs on (BrowserCommand `emulate`). */
export interface DeviceEmulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string | undefined;
}

export const responsive = "responsive";
export const minDimension = 100;
export const maxDimension = 4096;

const iosAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const ipadAgent =
  "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const androidAgent = (model: string) =>
  `Mozilla/5.0 (Linux; Android 15; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36`;

export const devicePresets: readonly DevicePreset[] = [
  {
    id: "iphone-se",
    label: "iPhone SE",
    kind: "phone",
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: iosAgent,
  },
  {
    id: "iphone-16-pro",
    label: "iPhone 16 Pro",
    kind: "phone",
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: iosAgent,
  },
  {
    id: "iphone-16-pro-max",
    label: "iPhone 16 Pro Max",
    kind: "phone",
    width: 440,
    height: 956,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: iosAgent,
  },
  {
    id: "pixel-9",
    label: "Pixel 9",
    kind: "phone",
    width: 412,
    height: 923,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent: androidAgent("Pixel 9"),
  },
  {
    id: "galaxy-s24",
    label: "Galaxy S24",
    kind: "phone",
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent: androidAgent("SM-S921B"),
  },
  {
    id: "ipad-mini",
    label: "iPad mini",
    kind: "tablet",
    width: 744,
    height: 1133,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: ipadAgent,
  },
  {
    id: "ipad-pro-11",
    label: "iPad Pro 11″",
    kind: "tablet",
    width: 834,
    height: 1210,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent: ipadAgent,
  },
  {
    id: "laptop",
    label: "Laptop",
    kind: "computer",
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
  },
  {
    id: "laptop-hidpi",
    label: "Laptop with HiDPI screen",
    kind: "computer",
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
    touch: false,
  },
  {
    id: "desktop",
    label: "Desktop",
    kind: "computer",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
  },
];

export const presetById = (id: string): DevicePreset | undefined =>
  devicePresets.find((preset) => preset.id === id);

export const clampDimension = (value: number) =>
  Math.min(maxDimension, Math.max(minDimension, Math.round(value)));

/** A preset at its own size, upright. */
export function presetSize(preset: DevicePreset): DeviceSize {
  return { preset: preset.id, width: preset.width, height: preset.height };
}

/** Any size of the person's choosing: the device toolbar's Responsive mode. */
export function responsiveSize(width: number, height: number): DeviceSize {
  return { preset: responsive, width: clampDimension(width), height: clampDimension(height) };
}

/** Width and height swapped: a phone turned on its side, or back. */
export function rotated(size: DeviceSize): DeviceSize {
  return { ...size, width: size.height, height: size.width };
}

/**
 * What the page is told for a size. A preset keeps its scale, touch and user agent whichever
 * way up it is; Responsive is a desktop page at the browser's own scale.
 */
export function emulationFor(size: DeviceSize, browserScale: number): DeviceEmulation {
  const preset = presetById(size.preset);
  return preset
    ? {
        width: size.width,
        height: size.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
        touch: preset.touch,
        userAgent: preset.userAgent,
      }
    : {
        width: size.width,
        height: size.height,
        deviceScaleFactor: Math.min(4, Math.max(1, browserScale)),
        mobile: false,
        touch: false,
      };
}

/**
 * The size an emulation (an agent's, say) shows as: the preset it is, either way up, or
 * Responsive at its size.
 */
export function sizeForEmulation(emulation: {
  width: number;
  height: number;
  mobile: boolean;
  deviceScaleFactor: number;
}): DeviceSize {
  const preset = devicePresets.find(
    (each) =>
      each.mobile === emulation.mobile &&
      each.deviceScaleFactor === emulation.deviceScaleFactor &&
      ((each.width === emulation.width && each.height === emulation.height) ||
        (each.width === emulation.height && each.height === emulation.width)),
  );
  return preset
    ? { preset: preset.id, width: emulation.width, height: emulation.height }
    : responsiveSize(emulation.width, emulation.height);
}

/** "Fit" or a fixed share of the device's size. */
export type DeviceScale = "fit" | number;
export const deviceScales: readonly DeviceScale[] = ["fit", 0.5, 0.75, 1, 1.25, 1.5];

/** The room the framed viewport keeps from the page area's edges. */
export const stageInset = 24;

/**
 * How large the device is drawn in the page area: the chosen share, never more than fits (the
 * page area does not scroll, and a native view can't be clipped by it).
 */
export function drawnScale(
  scale: DeviceScale,
  device: { width: number; height: number },
  stage: { width: number; height: number },
): number {
  const fit = Math.min(
    (stage.width - 2 * stageInset) / device.width,
    (stage.height - 2 * stageInset) / device.height,
  );
  const room = Math.max(0.05, fit);
  return scale === "fit" ? Math.min(1, room) : Math.min(scale, room);
}

export type ResizeHandle = "right" | "bottom" | "corner";

/**
 * The size while a handle is dragged by `dx`/`dy` screen pixels. The frame is centred across,
 * so its right edge moves half as far as its width grows: the width changes by twice the drag.
 * It hangs from the top, so the height follows the drag.
 */
export function draggedSize(
  start: { width: number; height: number },
  handle: ResizeHandle,
  drag: { dx: number; dy: number },
  scale: number,
): { width: number; height: number } {
  return {
    width: handle === "bottom" ? start.width : clampDimension(start.width + (2 * drag.dx) / scale),
    height: handle === "right" ? start.height : clampDimension(start.height + drag.dy / scale),
  };
}

/** An emulation as a tab lists it (`BrowserTab.emulation`): the device and who set it. */
export type TabEmulation = DeviceEmulation & { by: "human" | "agent" };

/** The iPhone whose width is nearest a phone screen's (in points): the page a phone opens at. */
export function phonePresetFor(screenWidth: number): DevicePreset {
  const iphones = devicePresets.filter((preset) => preset.id.startsWith("iphone-"));
  let best = iphones[0] ?? devicePresets[0];
  for (const preset of iphones)
    if (best && Math.abs(preset.width - screenWidth) < Math.abs(best.width - screenWidth))
      best = preset;
  if (!best) throw new Error("no device presets");
  return best;
}

/**
 * The phone's own device, "this phone": its view's size, with the scale, touch and user agent of
 * the iPhone nearest its width. The whole page fits the view, so nothing hides below it.
 */
export function phoneFitEmulation(view: { width: number; height: number }): DeviceEmulation {
  const preset = phonePresetFor(view.width);
  return {
    width: clampDimension(view.width),
    height: clampDimension(view.height),
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: preset.mobile,
    touch: preset.touch,
    userAgent: preset.userAgent,
  };
}

/**
 * What a screen opening a tab does about its device (ADR 0104). A tab that emulates a device (an
 * agent chose it, or the person did on any screen) keeps it. A tab with none gets this screen's
 * automatic device once; if this screen gave it one before and it has none now, someone removed
 * it, and the tab is left as it is.
 */
export function openingDevice(
  emulation: TabEmulation | undefined,
  appliedBefore: boolean,
): "keep" | "send" | "leave" {
  if (emulation) return "keep";
  return appliedBefore ? "leave" : "send";
}

/** The device's name as a menu shows it: a preset's label, else "Responsive". */
export function deviceLabel(size: DeviceSize): string {
  return presetById(size.preset)?.label ?? "Responsive";
}

/**
 * Whether a tab already shows `wanted`. An agent's plain size is taken as it is; a preset's
 * scale, touch and user agent must match too.
 */
export function emulationMatches(
  emulation: TabEmulation | undefined,
  wanted: DeviceEmulation,
): boolean {
  if (!emulation) return false;
  if (emulation.width !== wanted.width || emulation.height !== wanted.height) return false;
  if (emulation.by === "agent" && !wanted.mobile && !wanted.touch && !wanted.userAgent) return true;
  return (
    emulation.deviceScaleFactor === wanted.deviceScaleFactor &&
    emulation.mobile === wanted.mobile &&
    emulation.touch === wanted.touch &&
    (emulation.userAgent ?? "") === (wanted.userAgent ?? "")
  );
}
