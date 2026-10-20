import type { AppDevice, DeviceInput } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";

export type DeviceKey = Extract<DeviceInput, { kind: "key" }>["key"];

const watch = /\bwatch\b/i;

/**
 * Keys a device has no hardware for, refused before any backend is asked, with a way to get
 * the same result. Pure: every iOS and Android path shares these refusals.
 */
export function keyRefusal(
  device: Pick<AppDevice, "platform" | "name">,
  key: DeviceKey,
): DeviceError | undefined {
  const ios = device.platform === "ios";
  if (ios && key === "recents")
    return new DeviceError(
      "not_supported",
      "iOS Simulator has no Recents key",
      "A slow swipe up from the bottom edge opens the app switcher; or open_app the app you want.",
    );
  if (ios && key === "back")
    return new DeviceError(
      "not_supported",
      "iOS has no Back key",
      "Use a gesture or the app's back control.",
    );
  if (!ios && key === "action")
    return new DeviceError(
      "not_supported",
      "Android has no Action button",
      "The Action button is on iPhone 15 Pro and later; on Android, open_app or use the app's own control.",
    );
  if (key === "side" && !(ios && watch.test(device.name)))
    return new DeviceError(
      "not_supported",
      "Only Apple Watch has a side key",
      "On a phone or tablet the side or top button is the power key.",
    );
  return undefined;
}

/** The refusal for `key` on an Android device, thrown; for mappers whose switch must be total. */
export function refuseAndroidKey(key: DeviceKey): never {
  throw (
    keyRefusal({ platform: "android", name: "" }, key) ??
    new DeviceError(
      "not_supported",
      `Android has no ${key} key`,
      "Use the app's own controls instead.",
    )
  );
}

/** iOS keys serve-sim has no press for: the refusals above, or a plain not_supported. */
export function refuseSimulatorKey(key: DeviceKey): never {
  throw (
    keyRefusal({ platform: "ios", name: "" }, key) ??
    new DeviceError(
      "not_supported",
      `iOS Simulator has no ${key} key`,
      "Use the Simulator Device menu or the app's navigation.",
    )
  );
}
