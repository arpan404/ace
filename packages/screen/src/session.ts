import type { ScreenState, ScreenTarget } from "@ace/protocol";
import { FrameHub, type Frame } from "./frames.ts";
import type { Helper } from "./helper.ts";
import { Pixels } from "./pixels.ts";
import type { Recording } from "./recording.ts";
export type Session = {
  state: ScreenState;
  helper: Helper;
  hub: FrameHub;
  latest: Frame | undefined;
  epoch: number;
  owner: string | undefined;
  recording: Recording | undefined;
  actionTail: Promise<void>;
  queuedActions: number;
  recordingStarting: boolean;
  stopping: Promise<void> | undefined;
  pixels: Pixels;
  recordingLease: { release(): void } | undefined;
};
export function createSession(
  helper: Helper,
  id: string,
  target: ScreenTarget,
  indicator: (active: boolean) => void,
  failure: (error: Error) => void,
): Session {
  return {
    helper,
    hub: new FrameHub(),
    latest: undefined,
    epoch: 0,
    owner: undefined,
    recording: undefined,
    actionTail: Promise.resolve(),
    queuedActions: 0,
    recordingStarting: false,
    stopping: undefined,
    recordingLease: undefined,
    pixels: new Pixels(helper, indicator, failure),
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
