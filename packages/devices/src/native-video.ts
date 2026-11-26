// SPDX-License-Identifier: Apache-2.0

/**
 * U3's once-per-capture decisions (D3.3), read from the addon under `ACE_DEVICE_PLATFORM=native`:
 * the Simulator route, the helper endpoint and its routes, the screen config, the spawn plan,
 * the transcode plan, the host encoder's file and square, and a screenshot's bounds and fit.
 * Per-frame decisions (the H.264 feed, the published frame, per-picture JPEG framing) stay in
 * TypeScript: a JSON crossing per frame measured ~1,390x slower than the TypeScript conversion
 * (636 us against 0.46 us for an 8 KiB unit), so the Rust remains the library the all-Rust
 * daemon calls directly (ADR 0226).
 */
import { devicePlatformBackend } from "@ace/provider-kit/native-switches";

import { nativeDevices } from "./native-devices-addon.ts";
import { deviceAnswer } from "./sdk.ts";

export const nativeVideo = devicePlatformBackend() === "native";

export interface NativeSimulatorStart {
  route: "serveSim" | "screenHelper";
  replaceHelper: boolean;
}

/** The route a Simulator takes, or the `DeviceError` that refuses it. */
export function nativeSimulatorRoute(input: {
  supported: boolean;
  command: string | undefined;
  version: string | undefined;
  serveSimEnv: boolean;
  screenAvailable: boolean;
}): NativeSimulatorStart {
  return deviceAnswer(() =>
    nativeDevices().deviceCaptureSimulatorRoute(
      input.supported,
      input.command,
      input.version,
      input.serveSimEnv,
      input.screenAvailable,
    ),
  );
}

export function nativeNeedsToolsDownload(supported: boolean, serveSimEnv: boolean): boolean {
  return nativeDevices().deviceCaptureNeedsToolsDownload(supported, serveSimEnv);
}

export type NativeWindowChoice =
  | { choice: "one"; index: number }
  | { choice: "many" }
  | { choice: "none" };

export function nativeWindows(
  windows: readonly { bundleId: string; title: string }[],
  name: string,
): NativeWindowChoice {
  return JSON.parse(
    nativeDevices().deviceCaptureWindows(
      JSON.stringify(windows.map((window) => [window.bundleId, window.title])),
      name,
    ),
  ) as NativeWindowChoice;
}

export interface NativeEndpoint {
  device: string;
  port: number;
  streamUrl: string;
  wsUrl: string;
}

/** serve-sim's announced endpoint, or the error that it announced something else. */
export function nativeEndpoint(line: string): NativeEndpoint {
  return deviceAnswer(() => nativeDevices().deviceCaptureEndpoint(line));
}

export function nativeLocalUrl(value: string, port: number, protocol: string): string {
  return deviceAnswer(() => nativeDevices().deviceCaptureLocalUrl(value, port, protocol));
}

export function nativeSibling(stream: string, name: string): string {
  return deviceAnswer(() => nativeDevices().deviceCaptureSibling(stream, name));
}

export type NativeScreenConfig = {
  width: number;
  height: number;
  orientation?: string;
};

/** The screen config in a control message's payload, or undefined for another message. */
export function nativeScreenConfig(payload: Buffer): NativeScreenConfig | undefined {
  const text = nativeDevices().deviceCaptureScreenConfig(payload.toString("utf8"));
  return text === "null" ? undefined : (JSON.parse(text) as NativeScreenConfig);
}

export function nativeSpawnArgs(commandArgs: readonly string[], udid: string): string[] {
  return JSON.parse(
    nativeDevices().deviceCaptureSpawnArgs(JSON.stringify(commandArgs), udid),
  ) as string[];
}

export function nativeNeedsTranscode(input: {
  transcoding: boolean;
  bitrate: number;
  box: { maxWidth: number; maxHeight: number };
  native: { width: number; height: number } | undefined;
  source?: number | undefined;
}): boolean {
  return nativeDevices().deviceCaptureTranscode(
    input.transcoding,
    input.bitrate,
    input.box.maxWidth,
    input.box.maxHeight,
    input.native?.width,
    input.native?.height,
    input.source,
  );
}

export function nativeEncodeSpec(
  native: { width: number; height: number },
  settings: { maxWidth: number; maxHeight: number; bitrate: number },
): { id: number; codec: string; width: number; height: number; fps: number; bitrate: number } {
  return JSON.parse(
    nativeDevices().deviceCaptureEncodeSpec(
      native.width,
      native.height,
      settings.maxWidth,
      settings.maxHeight,
      settings.bitrate,
    ),
  ) as { id: number; codec: string; width: number; height: number; fps: number; bitrate: number };
}

export function nativeStillScale(encodedWidth: number, nativeWidth: number | undefined): number {
  return nativeDevices().deviceCaptureStillScale(encodedWidth, nativeWidth);
}

export function nativeHostFramesName(runtimeId: string): string {
  return nativeDevices().deviceHostFramesName(runtimeId);
}

export function nativeHostFramesBytes(width: number, height: number): number {
  return Number(nativeDevices().deviceHostFramesBytes(width, height));
}

export function nativeHostFramesEdge(box: number): number {
  return nativeDevices().deviceHostFramesEdge(box);
}

export function nativeScreenshotCheckSource(bytes: number): void {
  deviceAnswer(() => nativeDevices().deviceScreenshotCheckSource(bytes));
}

export interface NativeFitOp {
  maxPixels: number;
  width: number;
  height: number;
  autoOrient: boolean;
  quality: number;
}

export function nativeScreenshotFitOp(): NativeFitOp {
  return JSON.parse(nativeDevices().deviceScreenshotFitOp()) as NativeFitOp;
}

export function nativeScreenshotScale(encodedWidth: number, sourceWidth: number): number {
  return nativeDevices().deviceScreenshotScale(encodedWidth, sourceWidth);
}
