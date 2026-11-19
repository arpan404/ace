import { z } from "zod";
import type { DevicePosture } from "@ace/protocol/devices";

/**
 * The hinge angle each posture folds to, in degrees: 0 is shut, 180 flat. Half open sits well
 * inside the system's partly-open band (about 85° to 175° on an iPhone Duo), where a book rests.
 */
export const postureAngle: Record<DevicePosture, number> = {
  closed: 0,
  partiallyOpen: 120,
  open: 180,
};

const Display = z
  .object({
    primary: z.boolean().optional(),
    active: z.boolean().optional(),
    backlightState: z.string().optional(),
  })
  .passthrough();
const Displays = z
  .object({ result: z.object({ displays: z.array(z.unknown()).max(16) }).passthrough() })
  .passthrough();

/** How many screens a `devicectl` display report lists, or undefined when it can't be read. */
export function screenCount(report: unknown): number | undefined {
  const parsed = Displays.safeParse(report);
  return parsed.success ? parsed.data.result.displays.length : undefined;
}

/**
 * A device's posture from `devicectl device info displays --json-output`, or undefined when it
 * has fewer than two built-in screens (it doesn't fold) or the report can't be read.
 *
 * The lit panel decides: the cover (the primary display) lit means closed, the inner one lit
 * means open. A panel's `active` flag lags a fold, so it only breaks the tie when both or
 * neither panel is lit (the screen asleep). The inner panel can't tell open from half open, so
 * the last posture ace asked for decides between them.
 */
export function readPosture(report: unknown, requested?: DevicePosture): DevicePosture | undefined {
  const parsed = Displays.safeParse(report);
  if (!parsed.success) return undefined;
  const displays = parsed.data.result.displays.flatMap((raw) => {
    const display = Display.safeParse(raw);
    return display.success ? [display.data] : [];
  });
  if (displays.length < 2) return undefined;
  const cover = displays.find((display) => display.primary === true) ?? displays[0];
  if (!cover) return undefined;
  const lit = displays.filter(
    (display) => display.backlightState !== undefined && display.backlightState !== "off",
  );
  const shown = lit.length === 1 ? lit[0] : displays.find((display) => display.active === true);
  if (shown === cover) return "closed";
  if (requested === "partiallyOpen") return "partiallyOpen";
  if (shown === undefined && requested === "closed") return "closed";
  return "open";
}
