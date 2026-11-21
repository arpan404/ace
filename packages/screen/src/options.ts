import type { HelperOptions } from "./helper.ts";
import type { ModelImageRuntime } from "@ace/mcp-server";
import type { RecordingArtifact } from "./recording.ts";
import type { ScreenCowork } from "./cowork.ts";
import type { ScreenMedia } from "./media-source.ts";
export type ScreenOptions = Omit<HelperOptions, "onFrame" | "onFailure"> & {
  modelImageRuntime?: ModelImageRuntime;
  recordingDirectory: string;
  recordingLimitBytes?: number;
  publishArtifact: (artifact: RecordingArtifact) => Promise<void>;
  /** ace-media's recorder, which every screen recording goes through (X1); absent, recordings
   * refuse, saying why. */
  recorder?: import("@ace/media/tee-recordings").MediaRecorder;
  /**
   * Cowork (ADR 0143): the person's input reaches a session an agent holds without taking its
   * controls, and extends their lease on its app; agents' input there waits for it. Absent: the
   * person needs the controls (`controller: "human"`) to send input, as before.
   */
  cowork?: ScreenCowork;
  /**
   * ace-media (ADR 0147, X2): every session's live video goes through it and comes back on
   * egress. Absent: no live video, and a view that asks says so; stills still work.
   */
  media?: ScreenMedia;
  /** Unix ms, for frames ace-media encodes from a JPEG-only helper's pictures. */
  wallClock?: () => number;
};
