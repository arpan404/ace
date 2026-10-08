import { AgentId, ThreadId, type ScreenAgentScope } from "@ace/protocol";
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
  const actor = { kind: "human" as const, owner: "host-device-approval" };
  const delegation = {
    op: "controller" as const,
    deviceId,
    controller: "agent" as const,
    threadId: ThreadId.parse(caller.threadId),
    agentId: AgentId.parse(caller.agentId),
  };
  if (devices.approvedThread(deviceId) === caller.threadId) {
    signal.throwIfAborted();
    if (devices.states().find((state) => state.device.id === deviceId)?.controller === "none")
      await devices.request(delegation, actor);
    return;
  }
  const device = (await devices.list()).find((entry) => entry.id === deviceId);
  if (!device || !approvals) throw new Error("Device approval unavailable");
  await approvals.device(deviceId, device.name, caller, signal);
  signal.throwIfAborted();
  await devices.request({ op: "enable", enabled: true }, actor);
  await devices.request(
    { op: "approve", deviceId, threadId: ThreadId.parse(caller.threadId), allowed: true },
    actor,
  );
  signal.throwIfAborted();
  await devices.request(delegation, actor);
}
