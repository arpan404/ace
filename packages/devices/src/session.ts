import type { DeviceStreamControl } from "./stream-control.ts";
import { FrameHub, type Frame } from "@ace/screen";
import type {
  AppDevice as Device,
  DeviceActivity,
  DeviceFailure,
  DevicePosture,
} from "@ace/protocol/devices";
import { ControllerLease } from "./lease.ts";
import { DeviceLogs } from "./logs.ts";
import type { DeviceCapture } from "./capture.ts";
import type { DeviceRecording, PublishedRecording } from "./recording.ts";
export interface DeviceSession {
  device: Device;
  threadId?: string;
  booting?: boolean;
  recordingNotice?: string;
  logOwners: Map<string, object>;
  lifecycle: "idle" | "starting" | "live" | "stopping" | "failed";
  streamId?: string;
  error?: DeviceFailure;
  /** The last thing an agent did here, numbered by `activitySequence`. */
  activity?: DeviceActivity;
  activitySequence: number;
  /** A foldable device's posture, when ace can fold it. */
  posture?: DevicePosture;
  /** The posture read in flight, so overlapping refreshes share one. */
  readingPosture?: Promise<void>;
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
  /** Separate admission limits keep waiting agents from refusing the person's input. */
  pendingInput: { human: number; agent: number };
  generation: number;
  bindingEpoch: number;
  changingBinding: boolean;
  startup?: { controller: AbortController; capture: Promise<DeviceCapture | undefined> };
  recordingRelease?: Promise<void>;
  recordingClosing?: Promise<PublishedRecording>;
  /** A recording starting now; cleanup waits for it. Never rejects. */
  recordingStartup?: Promise<void>;
  /** The recording running now, teeing the capture's video into ace-media. */
  recording?: DeviceRecording;
  /** A recording that ended on its own, published, waiting for its `record.stop`. */
  completed?: DeviceRecording;
  recordingArtifact?: PublishedRecording;
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
    logOwners: new Map(),
    lease: new ControllerLease(runtime.now),
    tail: Promise.resolve(),
    pending: 0,
    pendingInput: { human: 0, agent: 0 },
    generation: 0,
    controlRevision: 0,
    bindingEpoch: 0,
    changingBinding: false,
    recordingStarting: false,
    activitySequence: 0,
  };
}
