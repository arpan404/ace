import type { ScreenTarget } from "@ace/protocol";
import { FrameHub, type Frame } from "./frames.ts";
import type { Helper } from "./helper.ts";
import type { Session } from "./session.ts";
export function captureSession(
  helper: Helper,
  id: string,
  target: ScreenTarget,
  generation: number,
): Session {
  return {
    helper,
    hub: new FrameHub(),
    epoch: 0,
    latest: undefined,
    sequence: -1,
    owner: undefined,
    recording: undefined,
    actionTail: Promise.resolve(),
    queuedActions: 0,
    recordingStarting: false,
    viewers: 0,
    captureActive: true,
    captureGeneration: generation,
    stopping: undefined,
    recordingResult: undefined,
    recordingFinalizing: false,
    snapshot: undefined,
    state: {
      sessionId: id,
      lifecycle: "starting",
      controller: "none",
      indicator: false,
      target,
      permissions: { screenRecording: false, accessibility: false },
    },
  };
}
/** Retired in-flight packets may finish on the pipe, but never enter a new capture. */
export function sessionFrames(
  read: () => Session | undefined,
  persistent: boolean,
  authorize: () => void,
  fail: (session: Session, error: Error) => void,
  demand: (session: Session) => void,
): (frame: Frame) => void {
  return (frame) => {
    const session = read();
    if (!session || (session.state.lifecycle !== "live" && session.state.lifecycle !== "starting"))
      return;
    if (frame.header.sessionId !== session.state.sessionId) return;
    if (
      persistent &&
      (!session.captureActive || frame.header.captureGeneration !== session.captureGeneration)
    )
      return;
    if (frame.header.sequence <= session.sequence) {
      fail(session, new Error("Invalid frame sequence"));
      return;
    }
    authorize();
    session.sequence = frame.header.sequence;
    session.latest = frame;
    if (session.snapshot) {
      session.snapshot.cancelTimeout();
      session.snapshot.resolve(frame);
      session.snapshot = undefined;
    }
    if (session.state.lifecycle === "live") {
      session.hub.publish(frame);
      session.recording?.push(frame);
      demand(session);
    }
  };
}
