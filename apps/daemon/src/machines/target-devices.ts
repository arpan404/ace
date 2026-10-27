import { z } from "zod";
import type { MachineToolResult } from "@ace/protocol";
import { ToolRegistry, nodeScheduler } from "@ace/mcp-server";
import type { DevicesService } from "@ace/devices";
import { devicesToolkit } from "@ace/devices/tools";
import type { CapabilityHost } from "./capability-hosts.ts";
import type { GuestScope, GuestSession, GuestSessions } from "./guest-sessions.ts";
import { TargetRefusal } from "./target-refusal.ts";
import { toolResult } from "./tool-result.ts";

/** The sim_* tools that only read (ADR 0105); every other one acts. */
const reads: ReadonlySet<string> = new Set(["sim_list", "sim_screenshot", "sim_ui", "sim_logs"]);

export interface TargetDevicesDeps {
  /** This machine's devices, loaded on first use; undefined when this daemon has none. */
  devices(): { load(): Promise<DevicesService> } | undefined;
  /** The calling machine's name when `threadId` is a guest session here. */
  guestMachine(threadId: string): string | undefined;
}

const Failure = z.looseObject({ code: z.string() });
const Started = z.looseObject({ guide: z.string() });
const SimId = z.looseObject({ simId: z.string() });

function json(result: MachineToolResult): unknown {
  const first = result.content[0];
  if (first?.type !== "text") return undefined;
  try {
    return JSON.parse(first.text);
  } catch {
    return undefined;
  }
}

/**
 * Simulators and emulators for agents on other machines (ADR 0105). Calls run through this
 * machine's own sim_* tools as the calling agent's guest owner, so leases, the thread binding and
 * a person's takeover apply exactly as they do to an agent here. What a remote agent holds is
 * released when its work is stopped or the person turns Simulators down for its machine.
 */
export class TargetDevices implements CapabilityHost {
  private deps: TargetDevicesDeps;
  private registry: { devices: object; tools: ToolRegistry } | undefined;
  /** Owners that have used devices here, with the session they called from. */
  private holders = new Map<string, GuestSession>();
  constructor(deps: TargetDevicesDeps) {
    this.deps = deps;
  }
  available(): boolean {
    return this.deps.devices() !== undefined;
  }
  readOnly(tool: string): boolean {
    return reads.has(tool);
  }
  /** Releases leases on the guest sessions' ends and revocations; returns the unsubscribe. */
  follow(guests: GuestSessions): () => void {
    const ended = guests.onEnd((end) => {
      if (end.capability === "devices") this.release(end.session.owner);
    });
    const revoked = guests.onRevoke((scope) => this.revoke(scope));
    return () => {
      ended();
      revoked();
    };
  }
  private tools(devices: { load(): Promise<DevicesService> }): ToolRegistry {
    if (this.registry?.devices !== devices) {
      const tools = new ToolRegistry({ scheduler: nodeScheduler });
      devicesToolkit(() => devices.load()).register(tools);
      this.registry = { devices, tools };
    }
    return this.registry.tools;
  }
  async call(
    session: GuestSession,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MachineToolResult> {
    const devices = this.deps.devices();
    if (!devices) throw new TargetRefusal("unavailable", "This machine has no devices.");
    const tools = this.tools(devices);
    if (!tools.names().includes(tool)) throw new TargetRefusal("invalid", "Unknown device tool.");
    this.holders.set(session.owner, session);
    const result = toolResult(
      await tools.call(
        tool,
        args,
        {
          scope: {
            sessionId: `machine:${session.deviceId}`,
            threadId: session.threadId,
            // The calling agent, so its owner here is the session's `owner`.
            agentId: session.agent,
            capabilities: ["devices"],
          },
          signal,
        },
        signal,
      ),
    );
    if (result.isError) return this.explain(result, args, devices);
    return tool === "sim_start" ? remoteGuide(result) : result;
  }
  /** A busy device names who holds it, so the calling agent knows which machine to wait on. */
  private async explain(
    result: MachineToolResult,
    args: Record<string, unknown>,
    devices: { load(): Promise<DevicesService> },
  ): Promise<MachineToolResult> {
    const failure = Failure.safeParse(json(result));
    const target = SimId.safeParse(args);
    if (!failure.success || failure.data.code !== "busy" || !target.success) return result;
    const holder = (await devices.load())
      .states()
      .find((state) => state.device.id === target.data.simId)?.holder;
    if (!holder) return result;
    const machine = this.deps.guestMachine(holder.threadId);
    const text = machine
      ? `An agent from ${machine} holds ${target.data.simId}.`
      : `An agent on this machine holds ${target.data.simId}.`;
    return { ...result, content: [...result.content, { type: "text" as const, text }].slice(0, 16) };
  }
  private release(owner: string): void {
    if (!this.holders.delete(owner)) return;
    const devices = this.deps.devices();
    // Only owners that used devices are held here, so the service is already loaded.
    void devices
      ?.load()
      .then((service) => service.disconnect(owner))
      .catch(() => undefined);
  }
  private revoke(scope: GuestScope): void {
    if (scope.capability !== undefined && scope.capability !== "devices") return;
    for (const [owner, session] of this.holders) {
      if (scope.deviceId !== undefined && session.deviceId !== scope.deviceId) continue;
      if (scope.threadId !== undefined && session.threadId !== scope.threadId) continue;
      // Read only can't drive a device, so it holds none either.
      this.release(owner);
    }
  }
}

/**
 * The first start's how-to, for an agent on another machine: the `ace sim` shell line names a
 * thread here, which that agent can't use; it passes `machine` on each sim_* call instead.
 */
function remoteGuide(result: MachineToolResult): MachineToolResult {
  const started = Started.safeParse(json(result));
  if (!started.success) return result;
  const guide = [
    ...started.data.guide.split("\n").filter((line) => !line.includes("ace sim")),
    "This device is on another machine: pass the same machine on every sim_* call.",
  ].join("\n");
  const [, ...rest] = result.content;
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify({ ...started.data, guide }) }, ...rest],
  };
}
