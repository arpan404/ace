import {
  HostId,
  MachineCallRequest,
  MachineCapability,
  type Device,
  type MachineAgentAccess,
  type MachineCall,
  type MachineCallOrigin,
  type MachineDescription,
  type MachineToolGroup,
  type ProviderKind,
} from "@ace/protocol";
import { ProviderKind as Providers } from "@ace/protocol";
import { allows } from "../devices.ts";
import type { Engine } from "../engine/index.ts";
import { TargetRefusal } from "./target-refusal.ts";
import type { TargetThreads } from "./target-threads.ts";
import type { TargetBrowser } from "./target-browser.ts";
import type { GuestSessions } from "./guest-sessions.ts";
import type { MachineGrantStore } from "./grant-store.ts";
import type { CapabilityHost, HostedCapability } from "./capability-hosts.ts";
import {
  capabilityOf,
  decide,
  effectiveGrants,
  grantsFor,
  pairingLevel,
  type GrantFacts,
  type Risk,
} from "./grant-rules.ts";

export interface MachineTargetDeps {
  hostId: string;
  hostName(): Promise<string>;
  /** This machine's opt-in, read on every call so turning it off applies at once. */
  access(): Promise<MachineAgentAccess>;
  engine(): Engine | undefined;
  threads: TargetThreads;
  browser: TargetBrowser;
  guests: GuestSessions;
  grants: MachineGrantStore;
  /** Devices, screen and commands, each when this machine has it (ADR 0105). */
  hosts: Partial<Record<HostedCapability, CapabilityHost>>;
  log(message: string, fields: Record<string, unknown>): void;
}
export interface MachineAnswer {
  status: number;
  body: unknown;
}

/**
 * The target side of machine calls. Each call is allowed by the grant rules (ADR 0105): this
 * machine's switch, the calling device's grant for the capability and its pairing scope, and the
 * calling thread's ceiling. Every call, allowed or refused, is logged with the device, the machine
 * and thread that made it, and the capability.
 */
export function createMachineTarget(deps: MachineTargetDeps) {
  async function facts(device: Device, origin: MachineCallOrigin): Promise<GrantFacts> {
    const master = await deps.access();
    return {
      master,
      grants: grantsFor(master, deps.grants.chosen(device.id)),
      pairing: pairingLevel({ read: allows(device, "read"), operate: allows(device, "operate") }),
      ceiling: origin.ceiling ?? "operate",
    };
  }
  /** Whether this call only reads; asked after the grant allows at least reading. */
  function risk(call: MachineCall): Risk {
    switch (call.op) {
      case "describe":
      case "status":
      case "browser.session":
        return "read";
      case "browser":
        return deps.browser.readOnly(call.tool, call.args) ? "read" : "operate";
      case "devices":
      case "screen":
        return deps.hosts[call.op]?.readOnly(call.tool, call.args) ? "read" : "operate";
      default:
        return "operate";
    }
  }
  /** The grant rules allow the call; refusals carry words the calling agent may read. */
  async function admit(device: Device, origin: MachineCallOrigin, call: MachineCall) {
    const known = await facts(device, origin);
    const capability = capabilityOf(call, deps.guests);
    const reading = decide(capability, "read", known);
    if (!reading.allow) throw new TargetRefusal(reading.code, reading.message);
    if (risk(call) === "operate") {
      const acting = decide(capability, "operate", known);
      if (!acting.allow) throw new TargetRefusal(acting.code, acting.message);
    }
    return known;
  }
  function serves(capability: MachineCapability): boolean {
    if (capability === "agents") return true;
    if (capability === "browser") return deps.browser.available();
    return deps.hosts[capability]?.available() ?? false;
  }
  async function describe(device: Device, origin: MachineCallOrigin, known: GrantFacts) {
    const engine = deps.engine();
    const providers: ProviderKind[] = engine
      ? Providers.options.filter((kind) => engine.providerAvailability(kind).installed)
      : [];
    const grants = effectiveGrants(known);
    // Callers from before ADR 0105 send no ceiling and read only these two groups.
    const groups: readonly MachineCapability[] =
      origin.ceiling === undefined ? ["agents", "browser"] : MachineCapability.options;
    const tools: MachineToolGroup[] = groups.filter(
      (capability) => grants[capability] !== "off" && serves(capability),
    );
    const description: MachineDescription = {
      hostId: HostId.parse(deps.hostId),
      name: (await deps.hostName()).slice(0, 256) || "ace",
      // What it meant before grants: whether this device's agents may start work here.
      access: grants.agents === "operate" ? "operate" : "read",
      grants,
      projects: deps.threads.projects(),
      tools,
      providers: providers.slice(0, 16),
      transfers: allows(device, "operate") && allows(device, "projects"),
    };
    return description;
  }
  async function hosted(
    device: Device,
    origin: MachineCallOrigin,
    call: Extract<MachineCall, { op: HostedCapability }>,
    signal: AbortSignal,
    ticket: number,
  ) {
    const host = deps.hosts[call.op];
    if (!host?.available() || !host.call)
      throw new TargetRefusal(
        "not_supported",
        "This machine allows it, but doesn't serve it to other machines yet.",
      );
    const session = await deps.guests.open(device, origin);
    const serve = host.call.bind(host);
    return deps.guests.run(
      session,
      {
        capability: call.op,
        risk: risk(call),
        label: `${call.tool} from ${origin.hostName}`,
        ticket,
      },
      signal,
      (stop) => serve(session, call.tool, call.args, stop),
    );
  }
  async function run(device: Device, request: MachineCallRequest, signal: AbortSignal) {
    const { call, origin } = request;
    // Taken before the grant is read: a Stop or a lowered grant after this point still wins
    // over a call that is only starting.
    const ticket = deps.guests.ticket();
    const owned = (threadId: string) => {
      if (!deps.threads.owns(device, threadId))
        throw new TargetRefusal("not_found", "No such thread from that machine.");
    };
    if (call.op === "message") {
      // A message refused here is refused for good: saved under its request before any copy
      // can be admitted, so the calling machine can stop waiting on it (ADR 0099).
      try {
        await admit(device, origin, call);
        owned(call.threadId);
      } catch (error) {
        if (error instanceof TargetRefusal)
          throw deps.threads.rejections.reject(device, call, error);
        throw error;
      }
      return deps.threads.message(device, call);
    }
    const known = await admit(device, origin, call);
    switch (call.op) {
      case "describe":
        return describe(device, origin, known);
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
        return { threadId: await deps.browser.session(device, origin) };
      case "browser":
        return deps.browser.call(
          device,
          origin,
          { tool: call.tool, args: call.args, ticket },
          signal,
        );
      case "devices":
      case "screen":
      case "commands":
        return hosted(device, origin, call, signal, ticket);
    }
  }
  return {
    /** The levels the person chose per linked machine, for Settings › Fleet. */
    grants: deps.grants,
    async handle(device: Device, body: unknown, signal: AbortSignal): Promise<MachineAnswer> {
      const parsed = MachineCallRequest.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: "invalid" } };
      const { call, origin } = parsed.data;
      const capability = capabilityOf(call, deps.guests);
      const fields = {
        device: device.name,
        deviceId: device.id,
        fromMachine: origin.hostName,
        fromThread: origin.threadId,
        ...(origin.agentId ? { fromAgent: origin.agentId } : {}),
        op: "tool" in call ? call.tool : call.op,
        capability: typeof capability === "string" ? capability : "any",
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
