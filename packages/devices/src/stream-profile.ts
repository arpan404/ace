/// <reference lib="dom" />
import type { ScreenStreamSettings } from "@ace/protocol";

const bucket = (value: number, limit: number) =>
  Math.min(limit, Math.max(64, Math.ceil(value / 64) * 64));
export type DeviceConnection = "local" | "remote" | "relay";

/** A live view asks for H.264 at this rate; a thin link steps it down (ADR 0149). */
export const deviceFrameRate = 60;
/**
 * Pressure stops lowering the bit rate here: the floor the daemon follows a 3G link down to
 * (`linkFloor` in `@ace/browser`'s link rate). There is no higher floor: the link decides.
 */
const minimumBitrate = 150_000;

/**
 * Per connection: the largest picture (a phone screen at its device pixel ratio fits the remote
 * box) and the bit rate a 60 fps stream asks for before any pressure. These are ceilings: the
 * daemon holds each view to what its link carries (`LinkFollow`), with fewer frames and then a
 * smaller picture on a thin link, so a relay view asks for what a remote one does.
 */
const budgets: Record<DeviceConnection, { width: number; height: number; bitrate: number }> = {
  local: { width: 3840, height: 3840, bitrate: 12_000_000 },
  remote: { width: 1440, height: 2880, bitrate: 8_000_000 },
  relay: { width: 1440, height: 2880, bitrate: 8_000_000 },
};

/**
 * The stream a live view asks for. Panel dimensions are physical pixels; the native capture keeps
 * its aspect ratio inside them. Pressure (0–3, the view falling behind) lowers the bit rate, and
 * only at its worst shrinks the picture of a remote or relay view. The link, followed by the
 * daemon, lowers the frame rate and then the size from there.
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

/** A Mac screen is landscape and full of text: larger boxes and more bits than a phone's. */
const screenBudgets: Record<DeviceConnection, { width: number; height: number; bitrate: number }> =
  {
    local: { width: 3840, height: 3840, bitrate: 16_000_000 },
    remote: { width: 2560, height: 2560, bitrate: 10_000_000 },
    relay: { width: 2560, height: 2560, bitrate: 10_000_000 },
  };

/**
 * The stream a computer-use live view asks for: H.264 at 60 fps sized to its panel (physical
 * pixels), with pressure lowering the bit rate first, as for a device, and the followed link
 * the frame rate and then the size.
 */
export function screenStreamProfile(
  panel: { width: number; height: number },
  connection: DeviceConnection,
  pressure = 0,
): ScreenStreamSettings {
  const budget = screenBudgets[connection];
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

/**
 * Whether this client's WebCodecs decodes the H.264 device live views stream: High profile
 * level 5.1, as Simulators send it (scrcpy's Baseline decodes wherever High does).
 */
export async function deviceVideoSupported(): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    return (
      (await VideoDecoder.isConfigSupported({ codec: "avc1.640033", optimizeForLatency: true }))
        .supported === true
    );
  } catch {
    return false;
  }
}

export { coalescedPointerMoves } from "./pointer-moves.ts";
