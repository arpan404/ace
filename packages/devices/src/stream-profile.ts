/// <reference lib="dom" />
import type { ScreenStreamSettings } from "@ace/protocol";

const bucket = (value: number, limit: number) =>
  Math.min(limit, Math.max(64, Math.ceil(value / 64) * 64));
export type DeviceConnection = "local" | "remote" | "relay";

/** A live view is H.264 at this rate on every connection, whatever the pressure. */
export const deviceFrameRate = 60;
/** Below this, 60 fps of a phone screen turns to mush; pressure stops lowering here. */
const minimumBitrate = 1_000_000;

/**
 * Per connection: the largest picture (a phone screen at its device pixel ratio fits the remote
 * and relay boxes) and the bit rate a 60 fps stream gets before any pressure.
 */
const budgets: Record<DeviceConnection, { width: number; height: number; bitrate: number }> = {
  local: { width: 3840, height: 3840, bitrate: 12_000_000 },
  remote: { width: 1440, height: 2880, bitrate: 8_000_000 },
  relay: { width: 1080, height: 2160, bitrate: 5_000_000 },
};

/**
 * The stream a live view asks for. Panel dimensions are physical pixels; the native capture keeps
 * its aspect ratio inside them. Pressure (0–3, the view falling behind) lowers the bit rate, and
 * only at its worst shrinks the picture of a remote or relay view. The frame rate never drops.
 */
export function deviceStreamProfile(
  panel: { width: number; height: number },
  connection: DeviceConnection,
  pressure = 0,
): ScreenStreamSettings {
  const budget = budgets[connection];
  const level = Math.max(0, Math.min(3, pressure));
  const shrink = level >= 3 && connection !== "local" ? 0.75 : 1;
  return {
    codec: "h264",
    maxWidth: bucket(Math.min(panel.width, budget.width) * shrink, budget.width),
    maxHeight: bucket(Math.min(panel.height, budget.height) * shrink, budget.height),
    fps: deviceFrameRate,
    bitrate: Math.max(minimumBitrate, Math.round(budget.bitrate / (1 + level * 0.5))),
  };
}

/** Whether this client's WebCodecs decodes the H.264 a device live view streams. */
export async function deviceVideoSupported(): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    return (
      (await VideoDecoder.isConfigSupported({ codec: "avc1.42E01F", optimizeForLatency: true }))
        .supported === true
    );
  } catch {
    return false;
  }
}

export { coalescedPointerMoves } from "./pointer-moves.ts";
