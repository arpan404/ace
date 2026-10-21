import type { ScreenState, ScreenTarget } from "@ace/protocol";
import { FrameHub, type Frame } from "./frames.ts";
import type { Helper } from "./helper.ts";
import { helperSession, type HelperPort } from "./helper-session.ts";
import { Pixels } from "./pixels.ts";
import type { Recording } from "./recording.ts";
export interface ControllerBinding {
  /** The external controller authority must still be live at input dispatch. */
  authorize(): void;
  /** Replacing or terminating this controller invalidates its external authority. */
  released(): void;
}
export type Session = {
  /** The policy epoch the latest frame was authorized under. */
  frameEpoch?: number;
  state: ScreenState;
  helper: HelperPort;
  humanView: boolean;
  nativeStarted: boolean;
  hub: FrameHub;
  latest: Frame | undefined;
  epoch: number;
  owner: string | undefined;
  pointerDown: boolean;
  pointerCleanup?: Promise<void>;
  controllerBinding: ControllerBinding | undefined;
  recording: Recording | undefined;
  completedRecording: Recording | undefined;
  actionTail: Promise<void>;
  queuedActions: number;
  recordingStarting: boolean;
  viewers: number;
  hadViewer: boolean;
  /** The frame rate the session started capturing at, before any viewer asked for more. */
  captureFps?: number;
  /** A viewer switched the helper to live video: the last viewer leaving switches it back. */
  viewerVideo?: boolean;
  releasing: boolean;
  stopping: Promise<void> | undefined;
  failureCleanup: Promise<void> | undefined;
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
  const session: Session = {
    humanView: false,
    nativeStarted: false,
    helper,
    hub: new FrameHub(),
    latest: undefined,
    epoch: 0,
    owner: undefined,
    pointerDown: false,
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
    failureCleanup: undefined,
    captureStopped: Promise.withResolvers<void>(),
    recordingLease: undefined,
    pixels: new Pixels(helper, indicator, failure, nextGeneration),
    state: {
      sessionId: id,
      lifecycle: "starting",
      controller: "none",
      mode: "background",
      secureInputAllowed: false,
      indicator: false,
      target,
      permissions: { screenRecording: false, accessibility: false },
      capabilities: helper.capabilities,
    },
  };
  session.helper = helperSession(helper, () => session.state);
  session.pixels = new Pixels(session.helper, indicator, failure, nextGeneration);
  return session;
}
