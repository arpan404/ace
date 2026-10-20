/// <reference lib="dom" />
import type { ScreenStreamSettings } from "@ace/protocol";

const bucket = (value: number, limit: number) =>
  Math.min(limit, Math.max(64, Math.ceil(value / 64) * 64));
export type DeviceConnection = "local" | "remote" | "relay";
/** Panel dimensions are physical pixels. Preserve aspect ratio in the native capture. */
export function deviceStreamProfile(
  panel: { width: number; height: number },
  connection: DeviceConnection,
  video: boolean,
  pressure = 0,
): ScreenStreamSettings {
  const limits =
    connection === "local"
      ? [3840, 3840, 60, 12000000]
      : connection === "remote"
        ? [1080, 1440, 30, 2500000]
        : [720, 1280, 30, 1200000];
  const factor = 1 / (1 + Math.max(0, Math.min(3, pressure)) * 0.5);
  return {
    codec: video ? "h264" : "jpeg",
    maxWidth: bucket(
      Math.min(panel.width, limits[0] ?? 3840) * (connection === "local" ? 1 : factor),
      limits[0] ?? 3840,
    ),
    maxHeight: bucket(
      Math.min(panel.height, limits[1] ?? 2160) * (connection === "local" ? 1 : factor),
      limits[1] ?? 2160,
    ),
    fps: pressure ? 30 : (limits[2] ?? 30),
    bitrate: Math.max(128000, Math.round((limits[3] ?? 2500000) * factor * factor)),
  };
}

/** Whether this client's WebCodecs decodes the H.264 a device live view asks for. */
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
