import type { DeviceStreamControl } from "./stream-control.ts";
import { FrameHub, type Frame, type Recording, type RecordingArtifact } from "@ace/screen";
import type { AppDevice as Device, DeviceFailure } from "@ace/protocol/devices";
import { ControllerLease } from "./lease.ts";
import { DeviceLogs } from "./logs.ts";
import type { DeviceCapture } from "./capture.ts";
export interface DeviceSession {
  device: Device;
  threadId?: string;
  booting?: boolean;
  recordingNotice?: string;
  logOwners: Set<string>;
  lifecycle: "idle" | "starting" | "live" | "stopping" | "failed";
  streamId?: string;
  error?: DeviceFailure;
  capture?: DeviceCapture;
  streamControl?: DeviceStreamControl;
  latest?: Frame;
  hub: FrameHub;
  logs: DeviceLogs;
  lease: ControllerLease;
  leaseExpiry?: () => void;
  controlRevision: number;
  pendingController?: string;
  tail: Promise<void>;
  pending: number;
  generation: number;
  approvalEpoch: number;
  changingApproval: boolean;
  startup?: { controller: AbortController; capture: Promise<DeviceCapture | undefined> };
  recordingRelease?: Promise<void>;
  recordingOpening?: Promise<Recording>;
  recordingClosing?: Promise<RecordingArtifact>;
  recording?: Recording;
  completed?: Recording;
  recordingArtifact?: { id: string; bytes: number; mimeType: string };
  recordingStarting: boolean;
  stopping?: Promise<void>;
  cancelStart?: () => void;
}
export function createSession(
  device: Device,
  runtime: { now(): number; after(ms: number, run: () => void): () => void },
): DeviceSession {
  return {
    device,
    lifecycle: "idle",
    hub: new FrameHub(),
    logs: new DeviceLogs(runtime.after),
    logOwners: new Set(),
    lease: new ControllerLease(runtime.now),
    tail: Promise.resolve(),
    pending: 0,
    generation: 0,
    controlRevision: 0,
    approvalEpoch: 0,
    changingApproval: false,
    recordingStarting: false,
  };
}
