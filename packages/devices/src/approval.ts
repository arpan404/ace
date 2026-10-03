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
  session.approvalEpoch++;
  delete session.threadId;
  const oldLogs = session.logs;
  // Close deactivates subscribers synchronously before awaiting subprocess exit.
  const closingLogs = oldLogs.close();
  session.logs = new DeviceLogs();
  try {
    const results = await Promise.allSettled([stopDevice(session, owner), closingLogs]);
    delete session.completed;
    delete session.recordingArtifact;
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Device approval cleanup failed");
    if (!owner.enabled())
      throw new DeviceError(
        "busy",
        "Devices disabled during approval",
        "Enable devices and retry.",
      );
    if (operation.allowed) {
      if (session.device.platform === "ios" && options.screen) {
        await options.screen.enable(true);
        await options.screen.approve("com.apple.iphonesimulator", true);
      }
      if (!owner.enabled())
        throw new DeviceError(
          "busy",
          "Devices disabled during approval",
          "Enable devices and retry.",
        );
      session.threadId = operation.threadId;
    }
  } finally {
    session.changingApproval = false;
  }
}
