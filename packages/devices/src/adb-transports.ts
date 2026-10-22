import { DeviceError } from "./sdk.ts";

/**
 * How adb reaches an Android device: an emulator on this machine (`emulator-5554`), a phone on
 * USB, or a device over the network (`adb connect host:port`, or wireless debugging's mDNS name).
 */
export type AdbTransportKind = "emulator" | "usb" | "network";

/**
 * Why a transport can't be used yet, as adb reports it: the device hasn't allowed this computer
 * (`unauthorized`, `authorizing`), or this Linux user can't open the USB device
 * (`no permissions`, a missing udev rule).
 */
export type AdbBlock = "unauthorized" | "no_permissions";

/** One line of `adb devices -l`. */
export type AdbTransport = {
  serial: string;
  kind: AdbTransportKind;
  state: "booted" | "offline" | "unauthorized";
  /** Set when `state` is `unauthorized`. */
  block?: AdbBlock;
  /** `model:Pixel_7` as a person reads it ("Pixel 7"). */
  model?: string;
  /** The USB port path (`usb:1-1`), for a device whose serial adb couldn't read. */
  usb?: string;
};

const maxTransports = 128;

/** `adb devices -l` lines, kept leniently: unknown states read as offline, never dropped. */
export function adbTransports(output: string): AdbTransport[] {
  const result: AdbTransport[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const match = /^(\S{1,200})\s+(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const [, serial, rest] = match;
    if (result.length >= maxTransports)
      throw new DeviceError(
        "limit",
        "Too many Android devices are connected",
        "Disconnect unused devices or emulators.",
      );
    const props = new Map<string, string>();
    for (const [, key, value] of rest.matchAll(
      /(?:^|\s)(usb|product|model|device|transport_id):(\S+)/g,
    ))
      if (key && value) props.set(key, value);
    const model = props.get("model")?.replaceAll("_", " ").slice(0, 128);
    const usb = props.get("usb");
    result.push({
      serial,
      kind: transportKind(serial),
      ...transportState(rest),
      ...(model ? { model } : {}),
      ...(usb ? { usb } : {}),
    });
  }
  return result;
}

/** What an adb serial names: an emulator here, a device on the network, else one on USB. */
export function transportKind(serial: string): AdbTransportKind {
  if (/^emulator-\d{4,5}$/.test(serial)) return "emulator";
  // `adb connect` names a device by its address; wireless debugging by an mDNS service name.
  if (/:\d{1,5}$/.test(serial) || /\._adb(?:-tls-connect)?\._tcp\.?$/.test(serial))
    return "network";
  return "usb";
}

function transportState(rest: string): Pick<AdbTransport, "state" | "block"> {
  const word = /^\S+/.exec(rest)?.[0] ?? "";
  if (word === "device") return { state: "booted" };
  if (word === "unauthorized" || word === "authorizing")
    return { state: "unauthorized", block: "unauthorized" };
  if (rest.startsWith("no permissions")) return { state: "unauthorized", block: "no_permissions" };
  // offline, connecting, recovery, sideload, bootloader, rescue, host, and states adb adds later.
  return { state: "offline" };
}

/**
 * The id part (after `android:`) for a device that isn't an emulator: its hardware serial
 * (`ro.serialno`) once adb can read it, so the same phone keeps its id over USB, over Wi-Fi and
 * across reconnects; else what adb calls the transport. Kept to the characters device ids allow.
 */
export function physicalIdPart(
  transport: Pick<AdbTransport, "serial" | "usb">,
  serialno?: string,
): string {
  const source =
    serialno ??
    (/^\?+$/.test(transport.serial) && transport.usb ? `usb-${transport.usb}` : transport.serial);
  return source.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200) || "device";
}

/** `ro.serialno` as getprop prints it, when it is one. */
export function hardwareSerial(output: string): string | undefined {
  const value = output.split("\n")[0]?.trim();
  return value && /^[\x21-\x7e]{1,200}$/.test(value) && value !== "unknown" ? value : undefined;
}

/** What a person calls a device that isn't an emulator. */
export function physicalName(transport: AdbTransport): string {
  if (transport.model) return transport.model;
  return transport.kind === "network" ? transport.serial : "Android device";
}

/** Why a blocked device can't be used, and what the person does about it. */
export function blockedError(
  transport: Pick<AdbTransport, "kind" | "block">,
  name: string,
  platform: string,
): DeviceError {
  if (transport.block === "no_permissions")
    return new DeviceError(
      "permission_denied",
      `${name} is connected, but this user can't open it over USB`,
      platform === "linux"
        ? "Linux needs a udev rule for Android devices: install your distribution's rules (Debian/Ubuntu: sudo apt install android-udev-rules; Fedora: sudo dnf install android-tools; Arch: sudo pacman -S android-udev), add yourself to the plugdev group (sudo usermod -aG plugdev $USER, then sign out and back in), unplug and replug the device, then run adb kill-server."
        : "Unplug and replug the device, then run adb kill-server.",
    );
  if (transport.kind === "network")
    return new DeviceError(
      "permission_denied",
      `${name} hasn't allowed this computer yet`,
      "On the device, allow the debugging prompt. For wireless debugging, pair first: Developer options > Wireless debugging > Pair device with pairing code, then run adb pair HOST:PORT and adb connect HOST:PORT.",
    );
  return new DeviceError(
    "permission_denied",
    `${name} is waiting for you to allow USB debugging`,
    'Unlock the device and tap Allow on the "Allow USB debugging?" prompt. No prompt? Unplug and replug it, or revoke USB debugging authorizations in Developer options and reconnect.',
  );
}
