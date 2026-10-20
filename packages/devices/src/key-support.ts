import type { DeviceInput } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";

export type DeviceKey = Extract<DeviceInput, { kind: "key" }>["key"];

/**
 * Keys a platform has no hardware for, refused before any backend is asked, with a way to get
 * the same result. Pure: every iOS and Android path shares these refusals.
 */
export function keyRefusal(platform: "ios" | "android", key: DeviceKey): DeviceError | undefined {
  if (platform === "ios" && key === "recents")
    return new DeviceError(
      "not_supported",
      "iOS Simulator has no Recents key",
      "A slow swipe up from the bottom edge opens the app switcher; or open_app the app you want.",
    );
  if (platform === "ios" && key === "back")
    return new DeviceError(
      "not_supported",
      "iOS has no Back key",
      "Use a gesture or the app's back control.",
    );
  if (platform === "android" && key === "action")
    return new DeviceError(
      "not_supported",
      "Android has no Action button",
      "The Action button is on iPhone 15 Pro and later; on Android, open_app or use the app's own control.",
    );
  return undefined;
}

/** The refusal for `key` on `platform`, thrown; for mappers whose switch must still be total. */
export function refuseKey(platform: "ios" | "android", key: DeviceKey): never {
  throw (
    keyRefusal(platform, key) ??
    new DeviceError(
      "not_supported",
      `The ${key} key is not supported on ${platform === "ios" ? "iOS Simulator" : "Android"}`,
      "Use the app's own controls instead.",
    )
  );
}
