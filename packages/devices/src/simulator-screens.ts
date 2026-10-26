import { z } from "zod";

/** One of a Simulator's built-in screens: devicectl's display id, native pixel size, and lit. */
export interface SimulatorScreen {
  id: number;
  width: number;
  height: number;
  active: boolean;
}

const Screen = z.object({
  displayId: z.number().int().min(0).max(64),
  nativeSize: z.tuple([z.number().positive(), z.number().positive()]),
  active: z.boolean().optional(),
});
const Report = z.object({
  result: z.object({ displays: z.array(z.unknown()).max(16) }).passthrough(),
});

/** The screens in `devicectl device info displays --json-output`; empty when unreadable. */
export function readSimulatorScreens(report: unknown): SimulatorScreen[] {
  const parsed = Report.safeParse(report);
  if (!parsed.success) return [];
  return parsed.data.result.displays.flatMap((raw) => {
    const screen = Screen.safeParse(raw);
    if (!screen.success) return [];
    const [width, height] = screen.data.nativeSize;
    return [{ id: screen.data.displayId, width, height, active: screen.data.active === true }];
  });
}

const near = (a: number, b: number) => Math.abs(a - b) <= 2;

/**
 * The display a touch belongs to, as the digitizer service names it: 0, the main screen, unless
 * the device has several screens (the iPhone Duo's cover and inner panels). Then it is the one
 * the streamed picture shows, matched by size (encoders round sizes to even pixels, so a pixel
 * or two either way still matches), or with no picture yet the one devicectl says is lit.
 */
export function touchTarget(
  screens: readonly SimulatorScreen[],
  picture: { width: number; height: number } | undefined,
): number {
  if (screens.length < 2) return 0;
  const shown =
    picture &&
    screens.find(
      (screen) =>
        (near(screen.width, picture.width) && near(screen.height, picture.height)) ||
        (near(screen.width, picture.height) && near(screen.height, picture.width)),
    );
  return (shown ?? screens.find((screen) => screen.active))?.id ?? 0;
}
