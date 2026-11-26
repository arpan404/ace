import type { AppDevice, DeviceState } from "@ace/protocol/devices";
import type { DeviceCapture } from "./capture.ts";
import { nativeDevices } from "./native-devices-addon.ts";
import { nativeInput } from "./native-input.ts";

/**
 * What a live view's touch input reaches: several fingers streamed live (scrcpy, serve-sim),
 * one finger streamed live (the iOS window capture), or whole gestures (the adb fallback, whose
 * input is `adb shell input`).
 */
export function deviceTouch(
  device: Pick<AppDevice, "platform">,
  capture: Pick<DeviceCapture, "input" | "multiTouch">,
): NonNullable<DeviceState["touch"]> {
  if (nativeInput)
    return nativeDevices().devicePlatformDeviceTouch(
      device.platform === "ios",
      Boolean(capture.multiTouch),
      Boolean(capture.input),
    ) as NonNullable<DeviceState["touch"]>;
  if (capture.multiTouch) return "multi";
  return capture.input || device.platform === "ios" ? "pointer" : "gestures";
}
