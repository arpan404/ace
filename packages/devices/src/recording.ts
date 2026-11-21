import { join } from "node:path";
import type { RecordedPart, RecordingEnd } from "@ace/media/recordings";
import type { ActiveRecording, MediaRecorder } from "@ace/media/tee-recordings";
import type { Frame } from "@ace/screen";
import { type DeviceStreamControl } from "./stream-control.ts";
import { DeviceError } from "./sdk.ts";
import type { DeviceSession } from "./session.ts";
import type { Actor } from "./lease.ts";
import type { LifecycleOwner, LifecycleOptions } from "./lifecycle.ts";
import { deviceRecordingLimit, deviceRecordingPartBytes } from "./recording-limits.ts";

/** A finished device recording as ace-media wrote it: its MP4 parts, in order. */
export type DeviceRecordingArtifact = {
  id: string;
  /** The directory ace-media wrote the parts into; the publisher owns it from here. */
  directory: string;
  parts: RecordedPart[];
};

/** What a published recording reports to its caller. */
export type PublishedRecording = { id: string; bytes: number; mimeType: string };

/** MediaFrame codec 1: H.264 Annex B, a keyframe carrying its parameter sets in front. */
const H264AnnexB = 1;

/**
 * One device recording (X1): the capture's H.264, teed into ace-media, which writes the MP4
 * parts. A recording ends once: stopped, at its size limit, or failed in ace-media; its parts are
 * published then, and every later `stop` returns that result.
 */
export class DeviceRecording {
  readonly id: string;
  readonly #recording: ActiveRecording;
  readonly #directory: string;
  readonly #publish: (artifact: DeviceRecordingArtifact) => Promise<PublishedRecording>;
  readonly #release: () => void;
  #result: Promise<PublishedRecording> | undefined;

  constructor(options: {
    id: string;
    directory: string;
    recording: ActiveRecording;
    publish: (artifact: DeviceRecordingArtifact) => Promise<PublishedRecording>;
    /** The capture may leave the recording's stream: called once the recording ends. */
    release: () => void;
  }) {
    this.id = options.id;
    this.#directory = options.directory;
    this.#recording = options.recording;
    this.#publish = options.publish;
    this.#release = options.release;
  }

  /** A frame the capture published; only its video is recorded. */
  push(frame: Frame): void {
    if (this.#result || frame.header.codec !== "h264") return;
    this.#recording.push({
      kind: "video",
      keyframe: frame.header.keyframe === true,
      codec: H264AnnexB,
      width: frame.header.width,
      height: frame.header.height,
      payload: frame.payload,
    });
  }

  /** Stops (once) and publishes the parts ace-media wrote. */
  stop(): Promise<PublishedRecording> {
    return (this.#result ??= this.#recording.stop().then((end) => this.#published(end)));
  }

  /** ace-media ended the recording itself: publish what it wrote. */
  ended(end: RecordingEnd): Promise<PublishedRecording> {
    return (this.#result ??= this.#published(end));
  }

  async #published(end: RecordingEnd): Promise<PublishedRecording> {
    this.#release();
    if (!end.parts.length)
      throw new DeviceError(
        "command_failed",
        end.ok ? "The recording has no video" : `The recording failed: ${end.reason}`,
        "Keep the device on screen while recording, then try again.",
      );
    return this.#publish({ id: this.id, directory: this.#directory, parts: end.parts });
  }
}

/** A daemon without ace-media can't record; it says so rather than record nothing. */
const missingRecorder: MediaRecorder = {
  start: () =>
    Promise.resolve({ ok: false, reason: "ace-media isn't available to record on this daemon" }),
};

/**
 * Starts a recording. Its startup is owned work: a capture stop or a move to another thread
 * waits for it (`closeDeviceRecording`), and a startup that finds the device moved on stops what
 * it opened, so no recording outlives the cleanup.
 */
export function recordDevice(
  session: DeviceSession,
  options: LifecycleOptions,
  streams: DeviceStreamControl,
  changed: () => void = () => {},
): Promise<void> {
  const starting = startRecording(session, options, streams, changed);
  const joined = starting.catch(() => {});
  session.recordingStartup = joined;
  return starting.finally(() => {
    if (session.recordingStartup === joined) delete session.recordingStartup;
  });
}

async function startRecording(
  session: DeviceSession,
  options: LifecycleOptions,
  streams: DeviceStreamControl,
  changed: () => void,
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
  let image: ReturnType<DeviceStreamControl["acquireRecording"]> | undefined;
  let released: Promise<void> | undefined;
  const release = () => {
    released ??= image?.release() ?? Promise.resolve();
    session.recordingRelease = released;
    void released.catch(() => {});
    return released;
  };
  let device: DeviceRecording | undefined;
  /** The recording ended on its own (its size limit, or ace-media failed it). */
  const finished = (notice: string): DeviceRecording | undefined => {
    if (!device || session.recording !== device) return undefined;
    session.recordingNotice = notice;
    delete session.recording;
    session.completed = device;
    changed();
    void release().catch(() => {});
    return device;
  };
  try {
    image = streams.acquireRecording();
    // ace-media records video: the capture stays on H.264 for as long as the recording runs.
    if ((await image.ready).codec !== "h264")
      throw new DeviceError(
        "not_supported",
        "This device's capture can't stream video for a recording",
        "Restart the device's live view; if it persists, check its capture tools.",
      );
    const id = options.runtime.id();
    const directory = join(options.recordingDirectory, `${id}.parts`);
    const limit = options.recordingLimitBytes ?? deviceRecordingLimit;
    let total = 0;
    const start = await (options.recorder ?? missingRecorder).start({
      origin:
        session.device.platform === "ios"
          ? { kind: "screen", platform: "ios-simulator" }
          : { kind: "scrcpy", host: "127.0.0.1", port: 0 },
      directory,
      maxBytes: Math.min(deviceRecordingPartBytes, limit),
      private: () => false,
      keyframe: () => void session.capture?.keyframe?.().catch(() => {}),
      part: (part) => {
        total += part.bytes;
        if (total < limit) return;
        const ended = finished(
          "Recording stopped at its size limit. The video is being saved to this thread.",
        );
        void ended?.stop().catch(() => {});
      },
      failed: (end) => {
        const ended = finished(
          "Recording stopped because it couldn't be written. Check free disk space and try again.",
        );
        void ended?.ended(end).catch(() => {});
      },
    });
    if (!start.ok)
      throw new DeviceError(
        "tool_missing",
        start.reason,
        "Restart ace; if recordings still can't start, run ace doctor.",
      );
    device = new DeviceRecording({
      id,
      directory,
      recording: start.recording,
      release: () => void release().catch(() => {}),
      publish: async (artifact) => {
        try {
          const result = (await options.publishArtifact(artifact, threadId)) ?? {
            id: artifact.id,
            bytes: artifact.parts.reduce((sum, part) => sum + part.bytes, 0),
            mimeType: "video/mp4",
          };
          if (session.bindingEpoch === epoch) session.recordingArtifact = result;
          return result;
        } catch (error) {
          if (session.bindingEpoch === epoch) {
            session.recordingNotice =
              "The recording couldn't be saved. Check the recording tools and try again.";
            changed();
          }
          throw error;
        }
      },
    });
    if (session.generation !== generation || session.bindingEpoch !== epoch) {
      await device.stop().catch(() => {});
      throw new DeviceError("busy", "Capture stopped during recording startup", "Restart capture.");
    }
    session.recording = device;
    // The recording starts at a keyframe; ask for one rather than wait for the capture's next.
    void session.capture?.keyframe?.().catch(() => {});
  } catch (error) {
    await release();
    throw error;
  } finally {
    session.recordingStarting = false;
  }
}

export async function stopDeviceRecording(
  session: DeviceSession,
  actor: Actor,
  owner: LifecycleOwner,
): Promise<PublishedRecording> {
  const recording = session.recording ?? session.completed;
  if (!recording) throw new DeviceError("not_found", "No recording", "Start recording first.");
  const epoch = session.bindingEpoch;
  const closing = recording.stop();
  session.recordingClosing = closing;
  delete session.recording;
  delete session.completed;
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
  return session.recordingArtifact ?? artifact;
}
