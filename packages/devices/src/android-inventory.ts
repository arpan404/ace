import type { AppDevice as Device } from "@ace/protocol/devices";
import { blockedError, physicalIdPart, physicalName, type AdbTransport } from "./adb-transports.ts";
import type { DeviceError } from "./sdk.ts";

/** A phone's or network device's `ro.serialno`, and its Android release when read. */
export type DeviceHardware = { serialno: string; release?: string };

/** The Android devices ace lists, and how each one is reached. */
export type AndroidInventory = {
  devices: Device[];
  transports: Map<string, Pick<AdbTransport, "kind" | "block">>;
  /** One problem per kind of blocked device (unauthorized, no USB permission). */
  blocked: DeviceError[];
  /** Two running emulators claim one AVD. */
  duplicate: boolean;
};

/**
 * Installed AVDs, the emulators adb reaches (named by their AVD), and phones and network devices
 * (identified by hardware serial once readable), merged into one list keyed by device id.
 */
export function androidInventory(input: {
  avds: readonly string[];
  emulators: readonly { serial: string; state: Device["state"]; name: string }[];
  physical: readonly AdbTransport[];
  hardware: ReadonlyMap<string, DeviceHardware>;
  platform: string;
}): AndroidInventory {
  const devices = new Map<string, Device>();
  const transports = new Map<string, Pick<AdbTransport, "kind" | "block">>();
  for (const name of input.avds) {
    const id = `android:${name}`;
    devices.set(id, { id, platform: "android", name, state: "shutdown" });
    transports.set(id, { kind: "emulator" });
  }
  let duplicate = false;
  for (const { serial, state, name } of input.emulators) {
    const id = `android:${name}`;
    const existing = devices.get(id);
    if (existing?.serial && existing.serial !== serial) {
      duplicate = true;
      devices.set(id, { ...existing, state: "offline" });
      continue;
    }
    devices.set(id, { id, platform: "android", name, state, serial });
    transports.set(id, { kind: "emulator" });
  }
  const blocked = new Map<string, DeviceError>();
  for (const transport of input.physical) {
    const hardware = input.hardware.get(transport.serial);
    const id = `android:${physicalIdPart(transport, hardware?.serialno)}`;
    const existing = devices.get(id);
    // One phone on USB and over Wi-Fi at once: a usable transport wins, then USB.
    if (existing && !preferred(transport, existing, transports.get(id)?.kind)) continue;
    const name = physicalName(transport);
    devices.set(id, {
      id,
      platform: "android",
      name,
      state: transport.state,
      serial: transport.serial,
      ...(hardware?.release ? { runtime: `Android ${hardware.release}` } : {}),
    });
    transports.set(id, {
      kind: transport.kind,
      ...(transport.block ? { block: transport.block } : {}),
    });
    if (transport.block && !blocked.has(transport.block))
      blocked.set(transport.block, blockedError(transport, name, input.platform));
  }
  return { devices: [...devices.values()], transports, blocked: [...blocked.values()], duplicate };
}

/** Whether `transport` should list a phone already listed through another of its transports. */
function preferred(
  transport: AdbTransport,
  existing: Device,
  existingKind: AdbTransport["kind"] | undefined,
): boolean {
  if (existingKind === "emulator") return false;
  if (transport.state === "booted" && existing.state !== "booted") return true;
  if (transport.state !== "booted" && existing.state === "booted") return false;
  return transport.kind === "usb" && existingKind !== "usb";
}
