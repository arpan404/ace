import { Recording, type RecordingArtifact } from "./recording.ts";
import type { Session } from "./session.ts";
export type RecordingOptions = {
  recordingDirectory: string;
  publishArtifact: (artifact: RecordingArtifact) => Promise<void>;
  nextId: () => string;
  recordingLimitBytes?: number;
};
export async function startRecording(
  session: Session,
  options: RecordingOptions,
  demand: () => void,
): Promise<void> {
  if (session.recording || session.recordingStarting || session.recordingFinalizing)
    throw new Error("Recording already active or publication pending");
  session.recordingStarting = true;
  session.recordingResult = undefined;
  try {
    let recording: Recording | undefined;
    const opened = await Recording.open(
      options.recordingDirectory,
      options.nextId(),
      options.publishArtifact,
      options.recordingLimitBytes,
      (completion) => {
        if (!recording || session.recording !== recording) return;
        session.recording = undefined;
        session.recordingFinalizing = true;
        session.recordingResult = completion;
        demand();
        void completion
          .finally(() => {
            session.recordingFinalizing = false;
          })
          .catch(() => {});
      },
    );
    recording = opened;
    if (session.state.lifecycle !== "live" || session.recording) {
      await recording.stop();
      throw new Error("Recording start cancelled");
    }
    session.recording = recording;
    demand();
  } finally {
    session.recordingStarting = false;
  }
}
export async function stopRecording(session: Session): Promise<RecordingArtifact> {
  const completion = session.recording?.stop() ?? session.recordingResult;
  if (!completion) throw new Error("No recording active");
  return completion;
}
export async function finishRecording(session: Session): Promise<void> {
  const completion = session.recording?.stop() ?? session.recordingResult;
  if (completion) await completion;
}
