import type { AppDevice, DeviceState } from "@ace/protocol/devices";
import type { DeviceCapture } from "./capture.ts";

/**
 * What a live view's touch input reaches: several fingers streamed live (scrcpy, serve-sim),
 * one finger streamed live (the iOS window capture), or whole gestures (the adb fallback, whose
 * input is `adb shell input`).
 */
export function deviceTouch(
  device: Pick<AppDevice, "platform">,
  capture: Pick<DeviceCapture, "input" | "multiTouch">,
): NonNullable<DeviceState["touch"]> {
  if (capture.multiTouch) return "multi";
  return capture.input || device.platform === "ios" ? "pointer" : "gestures";
}
