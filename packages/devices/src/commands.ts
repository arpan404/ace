import { z } from "zod";
import type { AppDevice as Device, DeviceInput } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";

const AVD = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const Serial = z.string().regex(/^emulator-\d{4,5}$/);
export function nativeId(device: Device): string {
  const prefix = `${device.platform}:`;
  if (!device.id.startsWith(prefix))
    throw new DeviceError(
      "invalid_data",
      "Device identity does not match its platform",
      "Refresh the device list.",
    );
  return device.platform === "ios"
    ? z.string().uuid().parse(device.id.slice(prefix.length))
    : AVD.parse(device.id.slice(prefix.length));
}
export function adbDevices(
  output: string,
): { serial: string; state: "booted" | "offline" | "unauthorized" }[] {
  const result: { serial: string; state: "booted" | "offline" | "unauthorized" }[] = [];
  for (const line of output.split("\n")) {
    const [serial, state] = line.trim().split(/\s+/);
    if (!Serial.safeParse(serial).success) continue;
    if (state !== "device" && state !== "offline" && state !== "unauthorized") continue;
    if (result.length >= 128)
      throw new DeviceError(
        "limit",
        "Too many Android emulator transports",
        "Close unused emulator instances.",
      );
    result.push({ serial: Serial.parse(serial), state: state === "device" ? "booted" : state });
  }
  return result;
}
export function avdNames(output: string): string[] {
  return z
    .array(AVD)
    .max(1024)
    .parse(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
}
export function avdName(output: string): string {
  return AVD.parse(output.split("\n")[0]?.trim());
}
/** adb shell joins its arguments before passing them to the device's shell. */
export function adbShell(tokens: readonly string[]): string[] {
  return ["shell", tokens.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ")];
}
const number = (value: number) => String(Math.round(value));
export function androidInput(input: DeviceInput): string[] {
  switch (input.kind) {
    case "tap":
      return adbShell(["input", "tap", number(input.x), number(input.y)]);
    case "longPress":
      return adbShell([
        "input",
        "swipe",
        number(input.x),
        number(input.y),
        number(input.x),
        number(input.y),
        String(input.durationMs),
      ]);
    case "swipe":
      return adbShell([
        "input",
        "swipe",
        number(input.x),
        number(input.y),
        number(input.toX),
        number(input.toY),
        String(input.durationMs),
      ]);
    case "type": {
      if (!/^[\x20-\x7e]*$/.test(input.text) || input.text.includes("%s"))
        throw new DeviceError(
          "not_supported",
          "adb input text supports printable ASCII without literal %s",
          "Use the app's own input method for Unicode or literal %s text.",
        );
      return adbShell(["input", "text", input.text.replaceAll(" ", "%s")]);
    }
    case "key": {
      if (input.key === "rotate")
        throw new DeviceError(
          "not_supported",
          "Rotate requires emulator configuration",
          "Use the rotate operation on the device service.",
        );
      const codes = { home: "3", back: "4", enter: "66", power: "26" };
      return adbShell(["input", "keyevent", codes[input.key]]);
    }
  }
}

export function androidDimensions(output: string): { width: number; height: number } {
  const physical = /^Physical size: (\d+x\d+)$/m.exec(output)?.[1];
  const override = /^Override size: (\d+x\d+)$/m.exec(output)?.[1];
  const value = override ?? physical;
  if (!value)
    throw new DeviceError(
      "invalid_data",
      "Android display size could not be decoded",
      "Check adb shell wm size on the selected emulator.",
    );
  const [width, height] = z
    .tuple([z.coerce.number().int().min(1).max(32768), z.coerce.number().int().min(1).max(32768)])
    .parse(value.split("x"));
  return { width, height };
}
