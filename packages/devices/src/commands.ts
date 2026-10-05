import { z } from "zod";
import {
  AppDevice as DeviceSchema,
  type AppDevice as Device,
  type DeviceInput,
} from "@ace/protocol/devices";
import type { ScreenInput } from "@ace/protocol";
import type { Simulator } from "@ace/screen";
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
    case "pointer":
      return adbShell([
        "input",
        "motionevent",
        input.phase === "down" ? "DOWN" : input.phase === "move" ? "MOVE" : "UP",
        number(input.x),
        number(input.y),
      ]);
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

/**
 * Hardware keys that are buttons on the Simulator window (its toolbar and side buttons), pressed
 * by accessible name: menu shortcuts reach Simulator only while it is the active app.
 */
const simulatorButtons: Partial<Record<Extract<DeviceInput, { kind: "key" }>["key"], string>> = {
  home: "Home",
  rotate: "Rotate",
  power: "Sleep/Wake",
};
export function simulatorButton(input: DeviceInput): string | undefined {
  return input.kind === "key" ? simulatorButtons[input.key] : undefined;
}
export function simulatorInput(input: DeviceInput): ScreenInput {
  let mapped: ScreenInput;
  if (input.kind === "pointer") {
    mapped =
      input.phase === "cancel"
        ? { kind: "pointer.cancel" }
        : {
            kind:
              input.phase === "down"
                ? "pointer.down"
                : input.phase === "up"
                  ? "pointer.up"
                  : "pointer.move",
            x: input.x,
            y: input.y,
          };
  } else if (input.kind === "swipe" || input.kind === "longPress")
    mapped = {
      kind: "pointer.drag",
      x: input.x,
      y: input.y,
      toX: input.kind === "swipe" ? input.toX : input.x,
      toY: input.kind === "swipe" ? input.toY : input.y,
      durationMs: input.durationMs,
      button: "left",
    };
  else if (input.kind === "tap")
    mapped = { kind: "pointer.click", x: input.x, y: input.y, button: "left" };
  else if (input.kind === "type") mapped = { kind: "text.type", text: input.text };
  else if (input.key === "enter") mapped = { kind: "key.press", key: "Return", modifiers: [] };
  else
    throw new DeviceError(
      "not_supported",
      "This hardware key is not supported by iOS Simulator",
      "Use the Simulator Device menu or the app's navigation.",
    );
  return mapped;
}

export function simulatorIdentity(input: Device, inventory: readonly Simulator[]): Device {
  const device = DeviceSchema.parse(input);
  const selected = inventory.find((candidate) => candidate.udid === nativeId(device));
  if (!selected || selected.state !== "Booted")
    throw new DeviceError(
      "not_booted",
      "Selected Simulator is not booted",
      "Boot this Simulator before starting capture.",
    );
  if (
    inventory.some(
      (candidate) =>
        candidate.udid !== selected.udid &&
        candidate.state === "Booted" &&
        candidate.name === selected.name,
    )
  )
    throw new DeviceError(
      "busy",
      "Booted Simulators have ambiguous display names",
      "Rename one Simulator or shut down the duplicate before starting capture.",
    );
  return DeviceSchema.parse({
    ...device,
    name: selected.name,
    state: "booted",
    runtime: simulatorRuntime(selected.runtime),
  });
}

/** "com.apple.CoreSimulator.SimRuntime.iOS-26-5" as a person reads it: "iOS 26.5". */
export function simulatorRuntime(identifier: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(identifier);
  return match?.[1] && match[2] ? `${match[1]} ${match[2].replaceAll("-", ".")}` : identifier;
}
