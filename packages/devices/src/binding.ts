import { DeviceError } from "./sdk.ts";
import { DeviceLogs } from "./logs.ts";
import {
  startDevice,
  stopDevice,
  type LifecycleOptions,
  type LifecycleOwner,
} from "./lifecycle.ts";
import type { DeviceSession } from "./session.ts";

/**
 * A device belongs to the thread whose agent or person took it last. Moving it to another thread
 * starts fresh logs and recordings, so nothing from the old thread reaches the new one, and
 * restarts a live view under the new thread.
 */
export async function bindDevice(
  session: DeviceSession,
  threadId: string,
  options: LifecycleOptions,
  owner: LifecycleOwner,
  guard: () => void,
): Promise<void> {
  if (session.threadId === threadId) return;
  if (session.changingBinding)
    throw new DeviceError("busy", "Device is changing threads", "Retry in a moment.");
  session.changingBinding = true;
  const epoch = ++session.bindingEpoch;
  const wasLive = session.lifecycle === "live";
  try {
    delete session.threadId;
    // Close deactivates subscribers synchronously before awaiting subprocess exit.
    const closingLogs = session.logs.close();
    session.logs = new DeviceLogs(options.runtime.after);
    session.logOwners.clear();
    const results = await Promise.allSettled([stopDevice(session, owner), closingLogs]);
    delete session.completed;
    delete session.recordingArtifact;
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Device binding cleanup failed");
    guard();
    if (!owner.enabled() || session.bindingEpoch !== epoch)
      throw new DeviceError(
        "busy",
        "Devices turned off while binding",
        "Turn devices on and retry.",
      );
    session.threadId = threadId;
  } finally {
    session.changingBinding = false;
  }
  if (wasLive) await startDevice(session, 60, options, owner);
}

/** Turning devices off frees every device from its thread and terminates its resources. */
export async function disableDeviceSessions(
  sessions: Iterable<DeviceSession>,
  owner: LifecycleOwner,
): Promise<void> {
  const cleanup = await Promise.allSettled(
    [...sessions].map(async (session) => {
      session.bindingEpoch++;
      delete session.threadId;
      const results = await Promise.allSettled([stopDevice(session, owner), session.logs.close()]);
      delete session.completed;
      delete session.recordingArtifact;
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Device disable cleanup failed");
    }),
  );
  const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Devices disable cleanup failed");
}
