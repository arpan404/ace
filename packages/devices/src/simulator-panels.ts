import { z } from "zod";
import type { DevicePosture } from "@ace/protocol/devices";

/*
 * A Simulator device type's built-in screens. Older Xcodes describe the one screen in the
 * device type's profile.plist (`mainScreenWidth` and friends); Xcode 27 lists every screen in
 * capabilities.plist instead, each with its own chrome and mask, so a foldable iPhone Duo has
 * a cover panel and an inner panel. Pure: the parsed files come in, the panels come out.
 */

const size = z.number().finite().positive().max(100_000);
const name = z.string().min(1).max(256);

/** The fields of a device type's profile.plist ace uses; every other one is ignored. */
export const SimulatorProfile = z.object({
  mainScreenWidth: size.optional().catch(undefined),
  mainScreenHeight: size.optional().catch(undefined),
  mainScreenScale: size.optional().catch(undefined),
  framebufferMask: name.optional().catch(undefined),
  sensorBarImage: name.optional().catch(undefined),
  chromeIdentifier: name.optional().catch(undefined),
});
export type SimulatorProfile = z.infer<typeof SimulatorProfile>;

const Display = z.object({
  displayType: z.literal("integrated"),
  width: size,
  height: size,
  scale: size,
  chromeIdentifier: name.optional().catch(undefined),
  framebufferMaskIdentifier: name.optional().catch(undefined),
});

/** The part of a device type's capabilities.plist ace uses: its screens. */
export const SimulatorCapabilities = z.object({
  capabilities: z.object({ displays: z.array(z.unknown()).max(16).catch([]) }).loose(),
});

/** One built-in screen: its size in points, the chrome it wears, its mask and its notch. */
export interface SimulatorPanel {
  width: number;
  height: number;
  chromeIdentifier?: string | undefined;
  framebufferMask?: string | undefined;
  sensorBarImage?: string | undefined;
}

/**
 * The device type's built-in screens, the one it shows by default first (an iPhone Duo's
 * cover). A screen's own chrome and mask win over the profile's; the notch is the first
 * screen's only, as the profile names one for the device. Empty when neither file says how big
 * the screen is.
 */
export function simulatorPanels(
  profile: SimulatorProfile,
  capabilities: unknown,
): SimulatorPanel[] {
  const listed = SimulatorCapabilities.safeParse(capabilities);
  const displays = (listed.success ? listed.data.capabilities.displays : []).flatMap((raw) => {
    const display = Display.safeParse(raw);
    return display.success ? [display.data] : [];
  });
  const panels: SimulatorPanel[] = displays.map((display, index) => ({
    width: display.width / display.scale,
    height: display.height / display.scale,
    chromeIdentifier: display.chromeIdentifier ?? profile.chromeIdentifier,
    framebufferMask:
      display.framebufferMaskIdentifier ?? (index === 0 ? profile.framebufferMask : undefined),
    sensorBarImage: index === 0 ? profile.sensorBarImage : undefined,
  }));
  if (panels.length > 0) return panels;
  const { mainScreenWidth: width, mainScreenHeight: height, mainScreenScale: scale } = profile;
  if (!width || !height || !scale) return [];
  return [
    {
      width: width / scale,
      height: height / scale,
      chromeIdentifier: profile.chromeIdentifier,
      framebufferMask: profile.framebufferMask,
      sensorBarImage: profile.sensorBarImage,
    },
  ];
}

/**
 * The screen a device shows in `posture`: a foldable's inner panel once it is open, even half
 * way, and its cover while shut. A device that doesn't fold always shows its one screen.
 */
export function shownPanel(
  panels: readonly SimulatorPanel[],
  posture?: DevicePosture,
): SimulatorPanel | undefined {
  const open = posture === "open" || posture === "partiallyOpen";
  return (open ? panels[1] : undefined) ?? panels[0];
}
