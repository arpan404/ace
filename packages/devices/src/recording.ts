import { type DeviceStreamControl } from "./stream-control.ts";
import { Recording } from "@ace/screen";
import { DeviceError } from "./sdk.ts";
import type { DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import type { LifecycleOwner, LifecycleOptions } from "./lifecycle.ts";
import { deviceRecordingSourceLimit } from "./recording-limits.ts";
import { RecordingFeed } from "./recording-feed.ts";
import { findExecutable } from "@ace/provider-kit/discovery";
export async function recordDevice(
  session: DeviceSession,
  options: LifecycleOptions,
  streams: DeviceStreamControl,
  changed: () => void = () => {},
): Promise<void> {
  if (!session.threadId)
    throw new DeviceError(
      "permission_denied",
      "Recording needs a thread using this device",
      "Call sim_start to take this simulator for the thread.",
    );
  if (session.lifecycle !== "live")
    throw new DeviceError("not_found", "Capture is not live", "Start capture before recording.");
  if (session.recording || session.recordingStarting || session.recordingClosing)
    throw new DeviceError("busy", "Recording already started", "Stop the recording first.");
  if (options.recordingAvailable && !options.recordingAvailable())
    throw new DeviceError(
      "tool_missing",
      "Device artifact registry is unavailable",
      "Configure ACE_WORKSPACE_ROOT before recording devices.",
    );
  delete session.recordingArtifact;
  delete session.recordingNotice;
  session.recordingStarting = true;
  const generation = session.generation;
  const threadId = session.threadId;
  const epoch = session.bindingEpoch;
  let recording: Recording | undefined;
  let feed: RecordingFeed | undefined;
  let image: ReturnType<DeviceStreamControl["acquireRecording"]> | undefined;
  let released: Promise<void> | undefined;
  const release = () => {
    released ??= image?.release() ?? Promise.resolve();
    session.recordingRelease = released;
    void released.catch(() => {});
    return released;
  };
  try {
    image = streams.acquireRecording();
    await image.ready;
    // A watched device stays on H.264; the recording decodes that video itself.
    const ffmpeg = await findExecutable("ffmpeg", options.env);
    const opening = Recording.open(
      options.recordingDirectory,
      options.runtime.id(),
      async (artifact) => {
        let result;
        try {
          result = await options.publishArtifact(artifact, threadId);
        } catch (error) {
          if (session.bindingEpoch === epoch) {
            session.recordingNotice =
              "The recording couldn't be saved. Check the recording tools and try again.";
            changed();
          }
          throw error;
        }
        if (result && session.bindingEpoch === epoch)
          session.recordingArtifact = {
            id: result.id,
            bytes: result.bytes,
            mimeType: result.mimeType,
          };
      },
      options.recordingLimitBytes ?? deviceRecordingSourceLimit,
      (reason) => {
        feed?.stop();
        if (session.recordingFeed === feed) delete session.recordingFeed;
        if (reason === "limit")
          session.recordingNotice =
            "Recording stopped at its size limit. The video is being saved to this thread.";
        if (reason === "error")
          session.recordingNotice =
            "Recording stopped because it couldn't be written. Check free disk space and try again.";
        if (recording && session.recording === recording) {
          delete session.recording;
          session.completed = recording;
          changed();
        }
        void release();
      },
    );
    session.recordingOpening = opening;
    recording = await opening;
    if (session.generation !== generation || session.bindingEpoch !== epoch) {
      await recording.stop();
      throw new DeviceError("busy", "Capture stopped during recording startup", "Restart capture.");
    }
    const writer = recording;
    feed = new RecordingFeed({
      streamId: session.streamId ?? options.runtime.id(),
      ffmpeg,
      runtime: options.runtime,
      env: options.env,
      write: (frame) => writer.push(frame),
      keyframe: () => void session.capture?.keyframe?.().catch(() => {}),
      failure: () => {
        session.recordingNotice =
          "Recording stopped because the video couldn't be decoded. Check ffmpeg and try again.";
        void writer.stop().catch(() => {});
      },
    });
    session.recording = recording;
    session.recordingFeed = feed;
    if (session.latest) feed.push(session.latest);
  } catch (error) {
    await release();
    throw error;
  } finally {
    delete session.recordingOpening;
    session.recordingStarting = false;
  }
}

export async function stopDeviceRecording(
  session: DeviceSession,
  actor: Actor,
  owner: LifecycleOwner,
): Promise<{ id: string; bytes: number; mimeType: string }> {
  const recording = session.recording ?? session.completed;
  if (!recording) throw new DeviceError("not_found", "No recording", "Start recording first.");
  const epoch = session.bindingEpoch;
  const closing = recording.stop();
  session.recordingClosing = closing;
  delete session.recording;
  let artifact;
  try {
    artifact = await closing;
    await session.recordingRelease;
  } finally {
    if (session.recordingClosing === closing) delete session.recordingClosing;
  }
  if (session.bindingEpoch !== epoch)
    throw new DeviceError(
      "busy",
      "Device moved to another thread",
      "Start a new recording for this thread.",
    );
  owner.authorize(session, actor);
  return (
    session.recordingArtifact ?? {
      id: artifact.id,
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
    }
  );
}
