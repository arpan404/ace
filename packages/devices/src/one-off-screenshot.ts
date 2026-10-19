import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { framePacket, type Frame } from "@ace/screen";
import type { AppDevice as Device } from "@ace/protocol/devices";
import { DeviceError } from "./sdk.ts";
import { adbShell } from "./commands.ts";
import type { DeviceRuntime } from "./runtime.ts";

/** One still of a device screen, JPEG, sized to fit a frame packet. */
export interface DeviceShot {
  payload: Buffer;
  width: number;
  height: number;
  /** Image pixels per device input point, as live frames report it. */
  scale: number;
}
/** The frame packet bounds (ScreenLegacyFrameHeader): a portrait phone is fitted to 2160 high. */
const maxWidth = 1920;
const maxHeight = 2160;
const maxSourceBytes = 32 * 1024 * 1024;

/** Re-encode a device's native screenshot (PNG or JPEG) as a JPEG that fits a frame packet. */
export async function shotJpeg(source: Buffer): Promise<DeviceShot> {
  if (!source.length || source.length > maxSourceBytes)
    throw new DeviceError(
      "invalid_data",
      "Device screenshot is empty or too large",
      "Retry; if it persists, restart the device.",
    );
  const { default: sharp } = await import("sharp");
  try {
    const image = sharp(source, { limitInputPixels: 64 * 1024 * 1024 });
    const { width: sourceWidth } = await image.metadata();
    const { data, info } = await image
      .resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    if (!sourceWidth) throw new Error("No image width");
    return {
      payload: data,
      width: info.width,
      height: info.height,
      scale: info.width / sourceWidth,
    };
  } catch {
    throw new DeviceError(
      "invalid_data",
      "Device screenshot could not be read",
      "Retry; if it persists, restart the device.",
    );
  }
}

/** Run `write` with a private temporary file path, and return the bytes it wrote there. */
export async function viaTemporaryFile(
  name: string,
  write: (path: string) => Promise<void>,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "ace-device-shot-"));
  try {
    const path = join(directory, name);
    await write(path);
    return await readFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A one-off still as a frame, so screenshot callers treat it like a live one. */
export function oneOffFrame(shot: DeviceShot, runtime: Pick<DeviceRuntime, "now" | "id">): Frame {
  const header = {
    version: 1 as const,
    sessionId: `shot-${runtime.id()}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64),
    sequence: 0,
    timestamp: runtime.now(),
    width: shot.width,
    height: shot.height,
    scale: shot.scale,
    codec: "jpeg" as const,
    keyframe: true,
    bytes: shot.payload.length,
  };
  return { header, payload: shot.payload, packet: framePacket(header, shot.payload) };
}

/** `screencap` on the device into a uniquely named guest file, pulled to the local `path`. */
export async function emulatorScreenshot(
  adb: (args: readonly string[], maxBytes: number) => Promise<unknown>,
  path: string,
): Promise<void> {
  const guest = `/data/local/tmp/ace-shot-${randomUUID()}.png`;
  try {
    await adb(adbShell(["screencap", "-p", guest]), 8192);
    await adb(["pull", guest, path], 8192);
  } finally {
    await adb(adbShell(["rm", "-f", guest]), 4096).catch(() => {});
  }
}

/** Commands that write one screenshot of a device to a local file. */
export interface ScreenshotCommands {
  /** `xcrun simctl io <udid> screenshot --type=png <path>`. */
  simulator(path: string): Promise<void>;
  /** `adb shell screencap -p` on the device, pulled to `path`. */
  emulator(path: string): Promise<void>;
}
export async function deviceScreenshot(
  device: Device,
  commands: ScreenshotCommands,
): Promise<DeviceShot> {
  const source = await viaTemporaryFile("screen.png", (path) =>
    device.platform === "ios" ? commands.simulator(path) : commands.emulator(path),
  );
  return shotJpeg(source);
}
