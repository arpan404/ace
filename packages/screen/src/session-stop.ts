import type { Session } from "./session.ts";
import { endSnapshot } from "./session.ts";
import { finishRecording } from "./session-recording.ts";

/** Cessation is acknowledged before publication; both failures remain observable. */
export async function stopCaptureSession(
  session: Session,
  stopNative: () => Promise<void>,
  emit: () => void,
): Promise<void> {
  session.epoch++;
  session.latest = undefined;
  endSnapshot(session);
  session.state = { ...session.state, lifecycle: "stopping", controller: "none" };
  session.hub.clear();
  emit();
  const errors: unknown[] = [];
  try {
    await stopNative();
  } catch (error) {
    errors.push(error);
  }
  // The owner either receives a stop acknowledgement or awaits process exit.
  session.state = { ...session.state, lifecycle: "stopped", indicator: false };
  emit();
  try {
    await finishRecording(session);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Screen stop failed");
}
