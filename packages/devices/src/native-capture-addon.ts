// SPDX-License-Identifier: Apache-2.0

/**
 * The addon's D3.3 capture exports, as `ace-daemon-node/src/devices/{emulator_grpc,logs,
 * recording}.rs` declare them: the emulator gRPC stream's request and answers, a log line and a
 * read's clamp, and a recording's once-per-recording decisions and publication plan.
 */
export interface CaptureAddon {
  deviceEmulatorScreenshotRequest(width: number, height: number, handle: string): Buffer;
  deviceEmulatorStatusRefusal(status: string): string | null;
  deviceEmulatorStreamEnded(): string;
  deviceLogLine(line: string): string;
  deviceLogsTailLimit(limit: number): number;
  deviceRecordingStartRefusal(
    hasThread: boolean,
    live: boolean,
    started: boolean,
    starting: boolean,
    closing: boolean,
    registryAvailable: boolean,
  ): string;
  deviceRecordingCodecRefusal(codec: string): string;
  deviceRecordingSizes(limit: number | undefined): string;
  deviceRecordingOrigin(platform: string): string;
  deviceRecordingEnd(ok: boolean, truncated: boolean, reason: string, parts: number): string;
  deviceRecordingNotice(kind: string, directory?: string): string;
  deviceRecordingParts(id: string, indexes: number[]): string;
  deviceRecordingPublishFailure(directory: string, root: string): string;
}
