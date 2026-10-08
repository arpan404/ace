import type { DeviceOperation } from "@ace/protocol/devices";
import { DeviceLogs } from "./logs.ts";
import { DeviceError } from "./sdk.ts";
import { stopDevice, type LifecycleOptions, type LifecycleOwner } from "./lifecycle.ts";
import type { DeviceSession } from "./session.ts";
export async function approveDevice(
  session: DeviceSession,
  operation: Extract<DeviceOperation, { op: "approve" }>,
  options: LifecycleOptions,
  owner: LifecycleOwner,
): Promise<void> {
  if (session.changingApproval)
    throw new DeviceError("busy", "Approval is changing", "Wait for approval cleanup.");
  session.changingApproval = true;
  const approvalEpoch = ++session.approvalEpoch;
  const previousThread = session.threadId;
  delete session.threadId;
  const oldLogs = session.logs;
  // Close deactivates subscribers synchronously before awaiting subprocess exit.
  const closingLogs = oldLogs.close();
  session.logs = new DeviceLogs();
  const revokeGrant = async (threadId: string | undefined) => {
    if (
      threadId &&
      session.device.platform === "ios" &&
      options.screen &&
      ![...owner.sessions()].some(
        (other) =>
          other !== session && other.device.platform === "ios" && other.threadId === threadId,
      )
    )
      await options.screen.approve("com.apple.iphonesimulator", false, "thread", threadId);
  };
  try {
    const results = await Promise.allSettled([
      stopDevice(session, owner),
      closingLogs,
      revokeGrant(previousThread),
    ]);
    delete session.completed;
    delete session.recordingArtifact;
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Device approval cleanup failed");
    if (!owner.enabled() || session.approvalEpoch !== approvalEpoch)
      throw new DeviceError(
        "busy",
        "Devices disabled during approval",
        "Enable devices and retry.",
      );
    if (operation.allowed) {
      if (session.device.platform === "ios" && options.screen) {
        await options.screen.enable(true);
        await options.screen.approve(
          "com.apple.iphonesimulator",
          true,
          "thread",
          operation.threadId,
        );
      }
      if (!owner.enabled() || session.approvalEpoch !== approvalEpoch) {
        await revokeGrant(operation.threadId);
        throw new DeviceError(
          "busy",
          "Devices disabled during approval",
          "Enable devices and retry.",
        );
      }
      session.threadId = operation.threadId;
    }
  } finally {
    session.changingApproval = false;
  }
}

/** Disable revokes each grant before independently terminating its owned resources. */
export async function disableDeviceSessions(
  sessions: Iterable<DeviceSession>,
  owner: LifecycleOwner,
  options: LifecycleOptions,
): Promise<void> {
  const entries = [...sessions];
  const threads = new Set(
    entries
      .filter((session) => session.device.platform === "ios")
      .flatMap((session) => (session.threadId ? [session.threadId] : [])),
  );
  const cleanup = await Promise.allSettled(
    entries.map(async (session) => {
      session.approvalEpoch++;
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
  for (const threadId of threads)
    await options.screen?.approve("com.apple.iphonesimulator", false, "thread", threadId);
  const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Devices disable cleanup failed");
}
