// SPDX-License-Identifier: Apache-2.0

/**
 * U3, U4 and U5's once-per-capture decisions (D3.3), read from the addon under
 * `ACE_DEVICE_PLATFORM=native`: the Simulator route, the helper endpoint and its routes, the
 * screen config, the spawn plan, the transcode plan, the host encoder's file and square, a
 * screenshot's bounds and fit, the capture refusals, an emulator gRPC stream's request and
 * answers, a log line, and a recording's start, end and publication.
 * Per-frame decisions (the H.264 feed, the published frame, per-picture JPEG framing, the gRPC
 * framing of each reply) stay in TypeScript: a JSON crossing per frame measured ~1,390x slower
 * than the TypeScript conversion (636 us against 0.46 us for an 8 KiB unit), so the Rust remains
 * the library the all-Rust daemon calls directly (ADR 0226).
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

/** Why an Android capture without scrcpy refuses a live view, with today's code and text. */
export function nativeAndroidLiveViewError(why: string): never {
  return deviceAnswer<never>(() => nativeDevices().deviceCaptureAndroidLiveViewError(why));
}

/** Why an Android live view does not start: no serial, or not booted. */
export function nativeAndroidNotBooted(): never {
  return deviceAnswer<never>(() => nativeDevices().deviceCaptureAndroidNotBooted());
}

/** Two Simulator windows show this device's name. */
export function nativeAmbiguousWindow(): never {
  return deviceAnswer<never>(() => nativeDevices().deviceCaptureAmbiguousWindow());
}

/** No Simulator window shows this device. */
export function nativeWindowNotFound(): never {
  return deviceAnswer<never>(() => nativeDevices().deviceCaptureWindowNotFound());
}

/** A screen helper that can't stream H.264 for a Simulator live view. */
export function nativeHelperVideoUnavailable(): never {
  return deviceAnswer<never>(() => nativeDevices().deviceCaptureHelperVideoUnavailable());
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

/** The `screenshotRequest` ace sends the emulator. */
export function nativeEmulatorRequest(width: number, height: number, handle: string): Buffer {
  return nativeDevices().deviceEmulatorScreenshotRequest(width, height, handle);
}

/** Why a non-zero `grpc-status` refuses the stream, or undefined when the status is fine. */
export function nativeEmulatorStatusRefusal(status: string): string | undefined {
  return nativeDevices().deviceEmulatorStatusRefusal(status) ?? undefined;
}

/** What an emulator stream that ended on its own reports. */
export function nativeEmulatorStreamEnded(): string {
  return nativeDevices().deviceEmulatorStreamEnded();
}

/** simctl's envelope as a readable log line, or the line as it came. */
export function nativeLogLine(line: string): string {
  return deviceAnswer<string>(() => nativeDevices().deviceLogLine(line));
}

/** The number of lines a log read shows, clamped. */
export function nativeLogsTailLimit(limit: number): number {
  return nativeDevices().deviceLogsTailLimit(limit);
}

export interface NativeRecordingSizes {
  limit: number;
  maxBytes: number;
}

/** A recording's whole limit and the most one MP4 part holds. */
export function nativeRecordingSizes(limit: number | undefined): NativeRecordingSizes {
  return JSON.parse(nativeDevices().deviceRecordingSizes(limit)) as NativeRecordingSizes;
}

/** Whether a recording may start, or why it may not. */
export function nativeRecordingStartRefusal(facts: {
  hasThread: boolean;
  live: boolean;
  started: boolean;
  starting: boolean;
  closing: boolean;
  registryAvailable: boolean;
}): never {
  return deviceAnswer<never>(() =>
    nativeDevices().deviceRecordingStartRefusal(
      facts.hasThread,
      facts.live,
      facts.started,
      facts.starting,
      facts.closing,
      facts.registryAvailable,
    ),
  );
}

/** A capture that isn't streaming H.264 can't be recorded. */
export function nativeRecordingCodecRefusal(codec: string): never {
  return deviceAnswer<never>(() => nativeDevices().deviceRecordingCodecRefusal(codec));
}

export type NativeRecordingOrigin =
  | { kind: "screen"; platform: string }
  | { kind: "scrcpy"; host: string; port: number };

/** Where ace-media reads a recording's video from. */
export function nativeRecordingOrigin(platform: "ios" | "android"): NativeRecordingOrigin {
  return JSON.parse(nativeDevices().deviceRecordingOrigin(platform)) as NativeRecordingOrigin;
}

export interface NativeRecordingFailure {
  code: string;
  message: string;
  hint: string;
}

export interface NativeRecordingEnd {
  truncated: boolean;
  failure: NativeRecordingFailure | null;
  noVideo: NativeRecordingFailure;
}

/** How a recording's end reads: its failure, its truncation and why it has no video. */
export function nativeRecordingEnd(input: {
  ok: boolean;
  truncated: boolean;
  reason: string;
  parts: number;
}): NativeRecordingEnd {
  return JSON.parse(
    nativeDevices().deviceRecordingEnd(input.ok, input.truncated, input.reason, input.parts),
  ) as NativeRecordingEnd;
}

/** A notice a recording leaves on its thread. */
export function nativeRecordingNotice(kind: string, directory?: string): string {
  return nativeDevices().deviceRecordingNotice(kind, directory);
}

export interface NativeRecordingPart {
  index: number;
  id: string;
  file: string;
  name: string;
}

/** The publication plan: each part's id, file and name, in ace-media's order. */
export function nativeRecordingParts(id: string, indexes: number[]): NativeRecordingPart[] {
  return JSON.parse(nativeDevices().deviceRecordingParts(id, indexes)) as NativeRecordingPart[];
}

/** Why a publication stopped, naming where the video is kept. */
export function nativeRecordingPublishFailure(directory: string, root: string): string {
  return nativeDevices().deviceRecordingPublishFailure(directory, root);
}
