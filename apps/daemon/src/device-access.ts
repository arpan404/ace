import { type ScreenAgentScope } from "@ace/protocol";
import type { DevicesService } from "@ace/devices";
import type { ScreenApprovals } from "./screen-approvals.ts";

/** Host approval owns enablement and delegation; agent tools cannot grant themselves access. */
export async function requestDeviceAccess(
  devices: DevicesService,
  approvals: ScreenApprovals | undefined,
  deviceId: string,
  caller: ScreenAgentScope,
  signal: AbortSignal,
): Promise<void> {
  if (devices.approvedThread(deviceId) === caller.threadId) {
    signal.throwIfAborted();
    return;
  }
  const device = (await devices.list()).find((entry) => entry.id === deviceId);
  if (!device || !approvals) throw new Error("Device approval unavailable");
  await approvals.device(deviceId, device.name, caller, signal);
  signal.throwIfAborted();
  await devices.grantAgentAccess(deviceId, caller, signal);
}
