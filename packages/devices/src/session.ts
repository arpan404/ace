import { FrameHub, type Frame, type Recording, type RecordingArtifact } from "@ace/screen";
import type { AppDevice as Device, DeviceFailure } from "@ace/protocol/devices";
import { ControllerLease } from "./lease.ts";
import { DeviceLogs } from "./logs.ts";
import type { DeviceCapture } from "./capture.ts";
export interface DeviceSession {
  device: Device;
  threadId?: string;
  lifecycle: "idle" | "starting" | "live" | "stopping" | "failed";
  streamId?: string;
  error?: DeviceFailure;
  capture?: DeviceCapture;
  latest?: Frame;
  hub: FrameHub;
  logs: DeviceLogs;
  lease: ControllerLease;
  tail: Promise<void>;
  pending: number;
  generation: number;
  approvalEpoch: number;
  changingApproval: boolean;
  startup?: { controller: AbortController; capture: Promise<DeviceCapture | undefined> };
  recordingOpening?: Promise<Recording>;
  recordingClosing?: Promise<RecordingArtifact>;
  recording?: Recording;
  completed?: Recording;
  recordingArtifact?: { id: string; bytes: number; mimeType: string };
  recordingStarting: boolean;
  stopping?: Promise<void>;
  cancelStart?: () => void;
}
export function createSession(device: Device, now: () => number): DeviceSession {
  return {
    device,
    lifecycle: "idle",
    hub: new FrameHub(),
    logs: new DeviceLogs(),
    lease: new ControllerLease(now),
    tail: Promise.resolve(),
    pending: 0,
    generation: 0,
    approvalEpoch: 0,
    changingApproval: false,
    recordingStarting: false,
  };
}
