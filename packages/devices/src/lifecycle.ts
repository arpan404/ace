import { type RecordingArtifact, type ScreenManager } from "@ace/screen";
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
  recordingLimitBytes?: number;
  capture?: typeof startCapture;
}
export interface LifecycleOwner {
  enabled(): boolean;
  sessions(): Iterable<DeviceSession>;
  list(): Promise<Device[]>;
  emit(session: DeviceSession): void;
  failure(error: unknown): DeviceFailure;
  authorize(session: DeviceSession, actor: Actor): void;
  /** A failure nobody asked about (a live view ending on its own), for the daemon log. */
  log(message: string, session: DeviceSession, error: unknown): void;
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
  if (session.capture || session.startup)
    throw new DeviceError(
      "busy",
      "Previous capture still owns native resources",
      "Stop capture successfully before restarting.",
    );
  let active = 0;
  for (const entry of owner.sessions())
    if (entry.capture || ["live", "starting", "stopping"].includes(entry.lifecycle)) active++;
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
  const controller = new AbortController();
  const cancel = options.runtime.after(10000, () => {
    controller.abort();
    firstReject?.(
      new DeviceError(
        "timeout",
        "No device frame arrived",
        "Check Screen Recording permission, ffmpeg and Android screenrecord support.",
      ),
    );
  });
  const opening = Promise.resolve().then(async () => {
    const device = (await owner.list()).find((candidate) => candidate.id === session.device.id);
    if (controller.signal.aborted || session.generation !== generation || !owner.enabled()) return;
    if (device?.state !== "booted")
      throw new DeviceError("not_booted", "Device is not booted", "Boot the device first.");
    session.device = device;
    const streamId = options.runtime.id();
    session.streamId = streamId;
    owner.emit(session);
    return (options.capture ?? startCapture)({
      device,
      ...(session.threadId ? { scope: { threadId: session.threadId, agentId: "human" } } : {}),
      streamId,
      fps,
      signal: controller.signal,
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
        if (frame.header.codec === "jpeg") session.recording?.push(frame);
      },
      failure(error) {
        if (session.generation !== generation) return;
        owner.log("Device live view ended", session, error);
        session.error = owner.failure(error);
        firstReject?.(error);
        void stopDevice(session, owner).catch(() => {});
      },
    });
  });
  const startup = { controller, capture: opening };
  session.startup = startup;
  try {
    const capture = await opening;
    if (session.generation !== generation || !owner.enabled()) {
      await session.stopping;
      return;
    }
    if (!capture) {
      await first;
      return;
    }
    session.capture = capture;
    if (session.startup === startup) delete session.startup;
    if (capture.streamId) session.streamId = capture.streamId;
    await first;
    if (session.generation !== generation || !owner.enabled()) {
      await session.stopping;
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
    if (session.startup === startup) delete session.startup;
    if (session.cancelStart === cancelStart) delete session.cancelStart;
  }
}
export function stopDevice(session: DeviceSession, owner: LifecycleOwner): Promise<void> {
  if (session.stopping) return session.stopping;
  session.generation++;
  session.cancelStart?.();
  delete session.cancelStart;
  session.leaseExpiry?.();
  delete session.leaseExpiry;
  session.lease.release();
  session.hub.clear();
  delete session.latest;
  session.lifecycle = "stopping";
  const capture = session.capture;
  const startup = session.startup;
  startup?.controller.abort();
  // Every resource is attempted independently. A failing native stop must not
  // strand a log subprocess or an open recording file.
  const stopping = Promise.resolve().then(async () => {
    const cleanupCapture = async () => {
      await session.streamControl?.close().catch(() => {});
      delete session.streamControl;
      let owned = capture;
      if (!owned && startup) {
        try {
          owned = await startup.capture;
        } catch {
          // A startup that failed owns nothing, and its own error is already the session's.
          // Reporting it again here would turn "permission missing" into "cleanup failed".
        }
      }
      if (owned) session.capture = owned;
      try {
        await owned?.stop();
      } finally {
        if (owned?.terminated) {
          if (session.capture === owned) delete session.capture;
          if (session.startup === startup) delete session.startup;
        }
      }
      if (session.capture === owned) delete session.capture;
      if (session.startup === startup) delete session.startup;
    };
    const cleanupRecording = async () => {
      const recording = session.recording ?? (await session.recordingOpening) ?? session.completed;
      const results = await Promise.allSettled([recording?.stop(), session.recordingClosing]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      delete session.recording;
      if (errors.length) throw new AggregateError(errors, "Device recording cleanup failed");
    };
    const results = await Promise.allSettled([
      cleanupCapture(),
      session.logs.stop(),
      cleanupRecording(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    delete session.streamId;
    if (errors.length) {
      const failure = new AggregateError(
        errors,
        `Device resource cleanup failed: ${errors.map((error) => (error instanceof Error ? error.message.slice(0, 512) : "Unknown cleanup error")).join("; ")}`,
      );
      session.error = owner.failure(failure);
      session.lifecycle = "failed";
      delete session.stopping;
      owner.emit(session);
      throw failure;
    }
    session.lifecycle = session.error ? "failed" : "idle";
    delete session.stopping;
    owner.emit(session);
  });
  session.stopping = stopping;
  owner.emit(session);
  return stopping;
}

export { recordDevice, stopDeviceRecording } from "./recording.ts";
