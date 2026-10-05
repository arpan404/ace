import { type DeviceStreamControl } from "./stream-control.ts";
import { Recording } from "@ace/screen";
import { DeviceError } from "./sdk.ts";
import type { DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import type { LifecycleOwner, LifecycleOptions } from "./lifecycle.ts";
export async function recordDevice(
  session: DeviceSession,
  options: LifecycleOptions,
  streams: DeviceStreamControl,
): Promise<void> {
  if (!session.threadId)
    throw new DeviceError(
      "permission_denied",
      "Recording needs an approved thread",
      "Approve this device for a thread.",
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
  session.recordingStarting = true;
  const generation = session.generation;
  const threadId = session.threadId;
  const epoch = session.approvalEpoch;
  let recording: Recording | undefined;
  let image: ReturnType<DeviceStreamControl["acquireImage"]> | undefined;
  let released: Promise<void> | undefined;
  const release = () => {
    released ??= image?.release() ?? Promise.resolve();
    session.recordingRelease = released;
    void released.catch(() => {});
    return released;
  };
  try {
    image = streams.acquireImage();
    await image.ready;
    const opening = Recording.open(
      options.recordingDirectory,
      options.runtime.id(),
      async (artifact) => {
        const result = await options.publishArtifact(artifact, threadId);
        if (result && session.approvalEpoch === epoch)
          session.recordingArtifact = {
            id: result.id,
            bytes: result.bytes,
            mimeType: result.mimeType,
          };
      },
      options.recordingLimitBytes ?? 50 * 1024 * 1024,
      () => {
        if (recording && session.recording === recording) {
          delete session.recording;
          session.completed = recording;
        }
        void release();
      },
    );
    session.recordingOpening = opening;
    recording = await opening;
    if (session.generation !== generation || session.approvalEpoch !== epoch) {
      await recording.stop();
      throw new DeviceError("busy", "Capture stopped during recording startup", "Restart capture.");
    }
    session.recording = recording;
    if (session.latest?.header.codec === "jpeg") recording.push(session.latest);
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
  const epoch = session.approvalEpoch;
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
  if (session.approvalEpoch !== epoch)
    throw new DeviceError(
      "busy",
      "Recording approval changed",
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
