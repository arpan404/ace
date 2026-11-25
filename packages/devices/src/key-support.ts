import type { AppDevice, DeviceInput } from "@ace/protocol/devices";
import { catalogRefusal, catalogToolFailure, DeviceError } from "./sdk.ts";
import { nativeInput, nativeKeyRefusal } from "./native-input.ts";

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
  if (nativeInput) return nativeKeyRefusal(ios, device.name, key);
  if (ios && key === "recents") return catalogRefusal("iosRecentsKey");
  if (ios && key === "back") return catalogRefusal("iosBackKey");
  if (!ios && key === "action") return catalogRefusal("androidActionKey");
  if (key === "side" && !(ios && watch.test(device.name))) return catalogRefusal("watchSideKey");
  return undefined;
}

/** The refusal for `key` on an Android device, thrown; for mappers whose switch must be total. */
export function refuseAndroidKey(key: DeviceKey): never {
  throw (
    keyRefusal({ platform: "android", name: "" }, key) ??
    catalogToolFailure("androidNoKeyHint", `Android has no ${key} key`)
  );
}

/** iOS keys serve-sim has no press for: the refusals above, or a plain not_supported. */
export function refuseSimulatorKey(key: DeviceKey): never {
  throw (
    keyRefusal({ platform: "ios", name: "" }, key) ??
    catalogToolFailure("iosNoKeyHint", `iOS Simulator has no ${key} key`)
  );
}
