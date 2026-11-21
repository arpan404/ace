import { join } from "node:path";
import { refusingRecorder } from "@ace/media/tee-recordings";
import { helperEncodesVideo } from "./helper-codecs.ts";
import { ScreenRecording, screenRecordingEncode, type RecordingArtifact } from "./recording.ts";
import type { ScreenOptions } from "./options.ts";
import type { Session } from "./session.ts";

/** The most a screen recording holds unless the options say: 50 MiB across its parts. */
const defaultLimitBytes = 50 * 1024 * 1024;
/** The least one part may hold, as ace-media keeps it. */
const minPartBytes = 64 * 1024;

/** Without ace-media a recording refuses, saying why, rather than record nothing. */
const missingRecorder = refusingRecorder("it isn't installed for this computer");

/**
 * Starts the session's recording through ace-media (X1). A screen whose helper encodes H.264
 * records that video; a JPEG-only screen records its pictures, which ace-media encodes. The
 * recording ends on its own at its size limit or when ace-media fails it; the session keeps it
 * as completed until it is stopped.
 */
export async function startSessionRecording(
  session: Session,
  options: ScreenOptions,
): Promise<void> {
  if (session.recording || session.recordingStarting) throw new Error("Recording already active");
  session.recordingStarting = true;
  try {
    const capabilities = session.helper.capabilities;
    const platform = capabilities?.platform ?? "unknown";
    const pictures = !helperEncodesVideo(capabilities);
    const id = options.nextId();
    const directory = join(options.recordingDirectory, `${id}.parts`);
    const limit = options.recordingLimitBytes ?? defaultLimitBytes;
    let total = 0;
    let recording: ScreenRecording | undefined;
    /** The recording ended on its own: the session keeps it, and capture is released. */
    const finished = (): ScreenRecording | undefined => {
      if (!recording || session.recording !== recording) return undefined;
      session.recording = undefined;
      session.completedRecording = recording;
      session.recordingLease?.release();
      session.recordingLease = undefined;
      void session.media?.recodec().catch(() => {});
      return recording;
    };
    const latest = session.latest?.header;
    const started = await (options.recorder ?? missingRecorder).start({
      origin: pictures ? { kind: "screen-pictures", platform } : { kind: "screen", platform },
      ...(pictures ? { encode: screenRecordingEncode(latest) } : {}),
      directory,
      maxBytes: Math.max(minPartBytes, limit),
      private: () => false,
      keyframe: () => void session.helper.request({ op: "stream.keyframe" }).catch(() => {}),
      part: (part) => {
        total += part.bytes;
        if (total >= limit)
          void finished()
            ?.stop()
            .catch(() => {});
      },
      failed: (end) =>
        void finished()
          ?.ended(end)
          .catch(() => {}),
    });
    if (!started.ok) throw new Error(started.reason);
    recording = new ScreenRecording({
      id,
      directory,
      recording: started.recording,
      pictures,
      publish: options.publishArtifact,
    });
    if (session.state.lifecycle !== "live" || session.recording) {
      await recording.discard();
      throw new Error("Recording start cancelled");
    }
    if (session.completedRecording) await session.completedRecording.stop().catch(() => {});
    session.completedRecording = undefined;
    session.recording = recording;
    const lease = session.pixels.acquire();
    session.recordingLease = lease;
    // The recording takes the screen's video as H.264, whatever ace-media's views prefer.
    await session.media?.recodec();
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
  void session.media?.recodec().catch(() => {});
  return result;
}
