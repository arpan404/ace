import { catalogRefusal, DeviceError, deviceAnswer } from "./sdk.ts";
import { nativeDevices } from "./native-devices-addon.ts";
import { nativeInput } from "./native-input.ts";

/** Clipboard text read or written in one call, in UTF-16 units: the same budget as typed text. */
export const clipboardLimit = 4096;

/** What a clipboard read returns: the text, cut to the limit when the device held more. */
export type ClipboardRead = { text: string; truncated: boolean };

/** A device clipboard reached over a capture's own control channel. */
export interface DeviceClipboard {
  /** `owner` is whose read it is: one owner's late answer never reaches another's read. */
  read(guard: () => void, owner: string): Promise<string>;
  write(text: string, guard: () => void): Promise<void>;
}

/** Bounds device clipboard text to the limit, never splitting a surrogate pair. */
export function boundedClipboard(raw: string, cut = false): ClipboardRead {
  if (nativeInput)
    return JSON.parse(
      nativeDevices().devicePlatformBoundedClipboard(JSON.stringify(raw), cut),
    ) as ClipboardRead;
  if (raw.length <= clipboardLimit) return { text: raw, truncated: cut };
  let end = clipboardLimit;
  const last = raw.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: raw.slice(0, end), truncated: true };
}

/** Android's clipboard is reachable only over the scrcpy control socket of the live view. */
export function androidClipboardUnavailable(): DeviceError {
  if (nativeInput)
    return deviceAnswer(() => nativeDevices().devicePlatformAndroidClipboardRefusal());
  return catalogRefusal("androidClipboardLiveView");
}
