import { Recording, type RecordingArtifact, type ScreenManager } from "@ace/screen";
import { startCapture } from "./capture.ts";
import { DeviceError } from "./sdk.ts";
import type { DeviceSession } from "./session.ts";
import type { DevicePlatform } from "./platform.ts";
import type { DeviceRuntime } from "./runtime.ts";
import type { AppDevice as Device, DeviceFailure } from "@ace/protocol/devices";
import type { Actor } from "./lease.ts";
import { mirrorDeviceController } from "./screen-controller.ts";

export interface LifecycleOptions {
  platform: DevicePlatform;
  runtime: DeviceRuntime;
  screen?: ScreenManager;
  env: NodeJS.ProcessEnv;
  recordingDirectory: string;
  publishArtifact(
    artifact: RecordingArtifact,
    threadId: string,
  ): Promise<{ id: string; bytes: number; mimeType: string } | void>;
  recordingAvailable?(): boolean;
  capture?: typeof startCapture;
}
export interface LifecycleOwner {
  enabled(): boolean;
  sessions(): Iterable<DeviceSession>;
  list(): Promise<Device[]>;
  emit(session: DeviceSession): void;
  failure(error: unknown): DeviceFailure;
  authorize(session: DeviceSession, actor: Actor): void;
}
export async function startDevice(
  session: DeviceSession,
  fps: number,
  options: LifecycleOptions,
  owner: LifecycleOwner,
): Promise<void> {
  if (session.lifecycle === "live") return;
  if (["starting", "stopping"].includes(session.lifecycle))
    throw new DeviceError(
      "busy",
      "Capture is changing state",
      "Wait for capture startup or shutdown.",
    );
  let active = 0;
  for (const entry of owner.sessions())
    if (["live", "starting"].includes(entry.lifecycle)) active++;
  if (active >= 4) throw new DeviceError("limit", "Capture limit", "Stop another device stream.");
  // Reserve before the first await so concurrent starts cannot open two captures.
  session.lifecycle = "starting";
  const generation = ++session.generation;
  delete session.error;
  owner.emit(session);
  let firstResolve: (() => void) | undefined;
  let firstReject: ((error: unknown) => void) | undefined;
  const first = new Promise<void>((resolve, reject) => {
    firstResolve = resolve;
    firstReject = reject;
  });
  void first.catch(() => {});
  const cancelStart = () =>
    firstReject?.(
      new DeviceError("busy", "Capture startup cancelled", "Start the device stream again."),
    );
  session.cancelStart = cancelStart;
  const cancel = options.runtime.after(10000, () =>
    firstReject?.(
      new DeviceError(
        "timeout",
        "No device frame arrived",
        "Check Screen Recording permission, ffmpeg and Android screenrecord support.",
      ),
    ),
  );
  try {
    const device = (await owner.list()).find((candidate) => candidate.id === session.device.id);
    if (session.generation !== generation || !owner.enabled()) return;
    if (device?.state !== "booted")
      throw new DeviceError("not_booted", "Device is not booted", "Boot the device first.");
    session.device = device;
    session.streamId = options.runtime.id();
    owner.emit(session);
    const capture = await (options.capture ?? startCapture)({
      device,
      streamId: session.streamId,
      fps,
      platform: options.platform,
      ...(options.screen ? { screen: options.screen } : {}),
      runtime: options.runtime,
      env: options.env,
      publish(frame) {
        if (session.generation !== generation || !["starting", "live"].includes(session.lifecycle))
          return;
        session.latest = frame;
        firstResolve?.();
        session.hub.publish(frame);
        session.recording?.push(frame);
      },
      failure(error) {
        if (session.generation !== generation) return;
        session.error = owner.failure(error);
        firstReject?.(error);
        void stopDevice(session, owner).catch(() => {});
      },
    });
    if (session.generation !== generation || !owner.enabled()) {
      await capture.stop();
      return;
    }
    session.capture = capture;
    if (capture.streamId) session.streamId = capture.streamId;
    await first;
    if (session.generation !== generation || !owner.enabled()) {
      await capture.stop();
      return;
    }
    session.lifecycle = "live";
    if (capture.screenSessionId && options.screen)
      mirrorDeviceController(
        session,
        options.screen,
        (actor) => owner.authorize(session, actor),
        () => owner.emit(session),
      );
    owner.emit(session);
  } catch (error) {
    // A concurrent stop owns the newer state. Never resurrect a disabled session
    // as failed when its first-frame promise is cancelled.
    if (session.generation === generation) {
      session.error = owner.failure(error);
      await stopDevice(session, owner);
    }
    throw error;
  } finally {
    cancel();
    if (session.cancelStart === cancelStart) delete session.cancelStart;
  }
}
export function stopDevice(session: DeviceSession, owner: LifecycleOwner): Promise<void> {
  if (session.stopping) return session.stopping;
  session.generation++;
  session.cancelStart?.();
  delete session.cancelStart;
  session.lease.release();
  session.hub.clear();
  delete session.latest;
  session.lifecycle = "stopping";
  owner.emit(session);
  const capture = session.capture;
  delete session.capture;
  session.stopping = (async () => {
    try {
      await capture?.stop();
      await session.logs.stop();
      const recording = session.recording;
      delete session.recording;
      await recording?.stop();
    } finally {
      delete session.streamId;
      session.lifecycle = session.error ? "failed" : "idle";
      delete session.stopping;
      owner.emit(session);
    }
  })();
  return session.stopping;
}
export async function recordDevice(
  session: DeviceSession,
  options: LifecycleOptions,
): Promise<void> {
  if (!session.threadId)
    throw new DeviceError(
      "permission_denied",
      "Recording needs an approved thread",
      "Approve this device for a thread.",
    );
  if (session.lifecycle !== "live")
    throw new DeviceError("not_found", "Capture is not live", "Start capture before recording.");
  if (session.recording || session.recordingStarting)
    throw new DeviceError("busy", "Recording already started", "Stop the recording first.");
  if (options.recordingAvailable && !options.recordingAvailable())
    throw new DeviceError(
      "tool_missing",
      "Device artifact registry is unavailable",
      "Configure ACE_WORKSPACE_ROOT before recording devices.",
    );
  delete session.recordingArtifact;
  session.recordingStarting = true;
  const generation = session.generation;
  const threadId = session.threadId;
  try {
    const recording = await Recording.open(
      options.recordingDirectory,
      options.runtime.id(),
      async (artifact) => {
        const result = await options.publishArtifact(artifact, threadId);
        if (result)
          session.recordingArtifact = {
            id: result.id,
            bytes: result.bytes,
            mimeType: result.mimeType,
          };
      },
      50 * 1024 * 1024,
      () => {
        if (session.recording === recording) {
          delete session.recording;
          session.completed = recording;
        }
      },
    );
    if (session.generation !== generation) {
      await recording.stop();
      throw new DeviceError("busy", "Capture stopped during recording startup", "Restart capture.");
    }
    session.recording = recording;
    if (session.latest) recording.push(session.latest);
  } finally {
    session.recordingStarting = false;
  }
}
