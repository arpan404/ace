import type { HelperOptions } from "./helper.ts";
import type { ModelImageRuntime } from "@ace/mcp-server";
import type { RecordingArtifact } from "./recording.ts";
import type { ScreenCowork } from "./cowork.ts";
export type ScreenOptions = Omit<HelperOptions, "onFrame" | "onFailure"> & {
  modelImageRuntime?: ModelImageRuntime;
  recordingDirectory: string;
  recordingLimitBytes?: number;
  publishArtifact: (artifact: RecordingArtifact) => Promise<void>;
  /**
   * Cowork (ADR 0143): the person's input reaches a session an agent holds without taking its
   * controls, and extends their lease on its app; agents' input there waits for it. Absent: the
   * person needs the controls (`controller: "human"`) to send input, as before.
   */
  cowork?: ScreenCowork;
};
