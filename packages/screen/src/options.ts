import type { HelperOptions } from "./helper.ts";
import type { ModelImageRuntime } from "@ace/mcp-server";
import type { RecordingArtifact } from "./recording.ts";
export type ScreenOptions = Omit<HelperOptions, "onFrame" | "onFailure"> & {
  modelImageRuntime?: ModelImageRuntime;
  recordingDirectory: string;
  recordingLimitBytes?: number;
  publishArtifact: (artifact: RecordingArtifact) => Promise<void>;
};
