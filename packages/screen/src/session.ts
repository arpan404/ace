import type { ScreenState } from "@ace/protocol";
import type { Helper } from "./helper.ts";
import type { FrameHub, Frame } from "./frames.ts";
import type { Recording } from "./recording.ts";
export type Session = {
  state: ScreenState;
  helper: Helper;
  hub: FrameHub;
  latest: Frame | undefined;
  epoch: number;
  owner: string | undefined;
  recording: Recording | undefined;
  actionTail: Promise<unknown>;
  viewers: number;
  captureActive: boolean;
  snapshot:
    | {
        resolve: (frame: Frame) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  queuedActions: number;
  recordingStarting: boolean;
};
export function captureDemand(
  session: Session,
  persistent: boolean,
  fail: (error: Error) => void,
): void {
  if (!persistent || session.state.lifecycle !== "live") return;
  const active =
    session.viewers > 0 ||
    session.recording !== undefined ||
    session.queuedActions > 0 ||
    session.snapshot !== undefined;
  if (active === session.captureActive) return;
  session.captureActive = active;
  void session.helper
    .requestV2({ op: "watch", active })
    .catch((error: unknown) =>
      fail(error instanceof Error ? error : new Error("Capture demand failed")),
    );
}
export async function freshScreenshot(
  session: Session,
  persistent: boolean,
  timeoutMs: number,
  demand: () => void,
): Promise<Frame> {
  if (!persistent || (session.captureActive && session.latest)) {
    if (!session.latest) throw new Error("No captured frame yet");
    return session.latest;
  }
  if (session.snapshot) throw new Error("Screenshot already pending");
  const result = new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.snapshot = undefined;
      demand();
      reject(new Error("Screenshot timed out"));
    }, timeoutMs);
    session.snapshot = { resolve, reject, timer };
  });
  demand();
  return result;
}
export function endSnapshot(session: Session): void {
  if (!session.snapshot) return;
  clearTimeout(session.snapshot.timer);
  session.snapshot.reject(new Error("Screen session ended"));
  session.snapshot = undefined;
}
