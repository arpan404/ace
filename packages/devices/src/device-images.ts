import { ImageError, type ImageWork } from "@ace/media/images";
import { DeviceError } from "./sdk.ts";

/*
 * Device pictures through ace-media (ADR 0201): one-off screenshots, chrome drawings, Simulator
 * bodies and emulator skins. Every job here has a deadline, so a device call never waits on
 * ace-media past it.
 */

export type { ImageWork };

/** Deadlines: a screenshot an agent waits on, and a look that is drawn once and cached. */
export const shotDeadlineMs = 10_000;
export const lookDeadlineMs = 15_000;

/** A failed image job as a device failure an agent or person can act on. */
export function deviceImageError(error: unknown, what: string): DeviceError {
  if (!(error instanceof ImageError))
    return new DeviceError(
      "invalid_data",
      `${what} could not be read`,
      "Retry; if it persists, restart the device.",
    );
  switch (error.reason) {
    case "busy":
      return new DeviceError("busy", `${what}: ${error.message}`, "Retry in a moment.");
    case "deadline":
    case "cancelled":
      return new DeviceError("timeout", `${what}: ${error.message}`, "Retry in a moment.");
    case "unavailable":
    case "exited":
    case "shutdown":
      return new DeviceError(
        "tool_missing",
        `${what}: ${error.message}`,
        "ace-media makes device pictures; run `ace doctor` to see why it isn't running.",
      );
    default:
      return new DeviceError(
        "invalid_data",
        `${what} could not be read: ${error.message}`,
        "Retry; if it persists, restart the device.",
      );
  }
}
