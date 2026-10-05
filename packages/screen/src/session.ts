import type { ScreenState, ScreenTarget } from "@ace/protocol";
import { FrameHub, type Frame } from "./frames.ts";
import type { Helper } from "./helper.ts";
import { Pixels } from "./pixels.ts";
import type { Recording } from "./recording.ts";
export interface ControllerBinding {
  /** The external controller authority must still be live at input dispatch. */
  authorize(): void;
  /** Replacing or terminating this controller invalidates its external authority. */
  released(): void;
}
import type { ModelCoordinates } from "./model-coordinates.ts";
export type Session = {
  modelCoordinates: ModelCoordinates | undefined;
  state: ScreenState;
  helper: Helper;
  hub: FrameHub;
  latest: Frame | undefined;
  epoch: number;
  owner: string | undefined;
  controllerBinding: ControllerBinding | undefined;
  recording: Recording | undefined;
  completedRecording: Recording | undefined;
  actionTail: Promise<void>;
  queuedActions: number;
  recordingStarting: boolean;
  viewers: number;
  hadViewer: boolean;
  releasing: boolean;
  stopping: Promise<void> | undefined;
  captureStopped: { promise: Promise<void>; resolve(): void };
  pixels: Pixels;
  recordingLease: { release(): void } | undefined;
};
export function createSession(
  helper: Helper,
  id: string,
  target: ScreenTarget,
  indicator: (active: boolean) => void,
  failure: (error: Error) => void,
  nextGeneration: () => number,
): Session {
  return {
    helper,
    modelCoordinates: undefined,
    hub: new FrameHub(),
    latest: undefined,
    epoch: 0,
    owner: undefined,
    controllerBinding: undefined,
    recording: undefined,
    completedRecording: undefined,
    actionTail: Promise.resolve(),
    queuedActions: 0,
    recordingStarting: false,
    viewers: 0,
    hadViewer: false,
    releasing: false,
    stopping: undefined,
    captureStopped: Promise.withResolvers<void>(),
    recordingLease: undefined,
    pixels: new Pixels(helper, indicator, failure, nextGeneration),
    state: {
      sessionId: id,
      lifecycle: "starting",
      controller: "none",
      indicator: false,
      target,
      permissions: { screenRecording: false, accessibility: false },
      capabilities: helper.capabilities,
    },
  };
}
