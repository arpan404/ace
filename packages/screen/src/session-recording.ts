import { Recording, type RecordingArtifact } from "./recording.ts";
import type { ScreenOptions } from "./options.ts";
import type { Session } from "./session.ts";
export async function startSessionRecording(
  session: Session,
  options: ScreenOptions,
): Promise<void> {
  if (session.recording || session.recordingStarting) throw new Error("Recording already active");
  session.recordingStarting = true;
  try {
    const recording = await Recording.open(
      options.recordingDirectory,
      options.nextId(),
      options.publishArtifact,
      options.recordingLimitBytes,
      () => {
        if (session.recording === recording) {
          session.recording = undefined;
          session.completedRecording = recording;
        }
        session.recordingLease?.release();
        session.recordingLease = undefined;
      },
    );
    if (session.state.lifecycle !== "live" || session.recording) {
      await recording.discard();
      throw new Error("Recording start cancelled");
    }
    if (session.completedRecording) await session.completedRecording.stop();
    session.completedRecording = undefined;
    session.recording = recording;
    const lease = session.pixels.acquire();
    session.recordingLease = lease;
    await lease.ready;
  } finally {
    session.recordingStarting = false;
  }
}
export async function stopSessionRecording(session: Session): Promise<RecordingArtifact> {
  const recording = session.recording ?? session.completedRecording;
  if (!recording) throw new Error("No recording active");
  session.recording = undefined;
  session.recordingLease?.release();
  session.recordingLease = undefined;
  const result = recording.stop();
  session.completedRecording = undefined;
  return result;
}
