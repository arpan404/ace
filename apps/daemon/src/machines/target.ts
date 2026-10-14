import {
  HostId,
  MachineCallRequest,
  type Device,
  type MachineAgentAccess,
  type MachineCall,
  type MachineDescription,
  type ProviderKind,
} from "@ace/protocol";
import { ProviderKind as Providers } from "@ace/protocol";
import { allows } from "../devices.ts";
import type { Engine } from "../engine/index.ts";
import { TargetRefusal } from "./target-refusal.ts";
import type { TargetThreads } from "./target-threads.ts";
import type { TargetBrowser } from "./target-browser.ts";

export interface MachineTargetDeps {
  hostId: string;
  hostName(): Promise<string>;
  /** This machine's opt-in, read on every call so turning it off applies at once. */
  access(): Promise<MachineAgentAccess>;
  engine(): Engine | undefined;
  threads: TargetThreads;
  browser: TargetBrowser;
  log(message: string, fields: Record<string, unknown>): void;
}
export interface MachineAnswer {
  status: number;
  body: unknown;
}
/** What each call needs: reading this machine's state, or acting on it. */
function needs(call: MachineCall, browser: TargetBrowser): "read" | "operate" {
  switch (call.op) {
    case "describe":
    case "status":
    case "browser.session":
      return "read";
    case "browser":
      return browser.readOnly(call.tool, call.args) ? "read" : "operate";
    default:
      return "operate";
  }
}

/**
 * The target side of machine calls. Authority is the lower of this machine's agent access
 * setting and the calling device's pairing scope; every call, allowed or refused, is logged
 * with the device and the machine and thread that made it.
 */
export function createMachineTarget(deps: MachineTargetDeps) {
  async function grant(device: Device): Promise<"read" | "operate"> {
    const access = await deps.access();
    if (access === "off")
      throw new TargetRefusal(
        "machine_opted_out",
        "Agents on other machines can't use this machine. The person can turn this on in Settings › Remote devices.",
      );
    if (!allows(device, "read")) throw new TargetRefusal("machine_forbidden");
    return access === "operate" && allows(device, "operate") ? "operate" : "read";
  }
  async function describe(access: "read" | "operate") {
    const engine = deps.engine();
    const providers: ProviderKind[] = engine
      ? Providers.options.filter((kind) => engine.providerAvailability(kind).installed)
      : [];
    const description: MachineDescription = {
      hostId: HostId.parse(deps.hostId),
      name: (await deps.hostName()).slice(0, 256) || "ace",
      access,
      projects: deps.threads.projects(),
      tools: deps.browser.available() ? ["agents", "browser"] : ["agents"],
      providers: providers.slice(0, 16),
    };
    return description;
  }
  async function run(device: Device, request: MachineCallRequest, signal: AbortSignal) {
    const { call, origin } = request;
    const access = await grant(device);
    if (needs(call, deps.browser) === "operate" && access !== "operate")
      throw new TargetRefusal(
        "machine_forbidden",
        "Agents from that machine may only read here. Use a read-only tool, or ask the person to allow more in Settings › Remote devices.",
      );
    const owned = (threadId: string) => {
      if (!deps.threads.owns(device, threadId))
        throw new TargetRefusal("not_found", "No such thread from that machine.");
    };
    switch (call.op) {
      case "describe":
        return describe(access);
      case "delegate":
        return deps.threads.delegate(device, origin, call);
      case "status":
        for (const id of call.threadIds) owned(id);
        return { threads: call.threadIds.map((id) => deps.threads.view(id)) };
      case "cancel":
        owned(call.threadId);
        return deps.threads.cancel(device, call.threadId);
      case "respond":
        owned(call.threadId);
        return deps.threads.respond(device, call);
      case "browser.session":
        return { threadId: deps.browser.session(device, origin) };
      case "browser":
        return deps.browser.call(device, origin, call.tool, call.args, signal);
    }
  }
  return {
    async handle(device: Device, body: unknown, signal: AbortSignal): Promise<MachineAnswer> {
      const parsed = MachineCallRequest.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: "invalid" } };
      const { call, origin } = parsed.data;
      const fields = {
        device: device.name,
        deviceId: device.id,
        fromMachine: origin.hostName,
        fromThread: origin.threadId,
        op: call.op === "browser" ? call.tool : call.op,
      };
      try {
        const result = await run(device, parsed.data, signal);
        deps.log("Machine call from another device", { ...fields, outcome: "ok" });
        return { status: 200, body: result };
      } catch (error) {
        const refusal = error instanceof TargetRefusal ? error : new TargetRefusal("unavailable");
        deps.log("Machine call from another device refused", {
          ...fields,
          outcome: refusal.code,
        });
        return { status: refusal.status, body: refusal.body() };
      }
    },
  };
}
export type MachineTarget = ReturnType<typeof createMachineTarget>;
