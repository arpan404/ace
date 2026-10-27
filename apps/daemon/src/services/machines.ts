import { randomUUID } from "node:crypto";
import { logError, logFields } from "@ace/diagnostics";
import { HostId, MachineDescription, ThreadId } from "@ace/protocol";
import { redeemPairing } from "../client-access.ts";
import { FleetLinks } from "../machines/fleet-links.ts";
import { computerName } from "../computer-name.ts";
import { loadHostId } from "../local-files.ts";
import { Profiles } from "../cli/profiles.ts";
import { createMachineTarget } from "../machines/target.ts";
import { TargetRefusal } from "../machines/target-refusal.ts";
import { TargetThreads } from "../machines/target-threads.ts";
import { TargetBrowser } from "../machines/target-browser.ts";
import { TargetDevices } from "../machines/target-devices.ts";
import { GuestSessions } from "../machines/guest-sessions.ts";
import { MachineGrantStore } from "../machines/grant-store.ts";
import { unservedHost } from "../machines/capability-hosts.ts";
import { MachineDirectory } from "../machines/directory.ts";
import { MachineChildren } from "../machines/children.ts";
import { RequestMirror } from "../machines/mirror.ts";
import { MachineCaller } from "../machines/caller.ts";
import { machineRequest } from "../machines/transport.ts";
import { TransferClient, transferTransport } from "../transfers/client.ts";
import type { ServiceContext } from "./types.ts";

/** The shell's timers for polls; nothing waits on them at exit. */
function schedule(ms: number, run: () => void) {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/**
 * Agents across the person's paired machines (ADR 0078): this machine answering agents from
 * elsewhere, and agents here using other machines through this daemon's own device tokens.
 */
export function startMachines(context: ServiceContext): void {
  const { services, store, config, options, log, resources, now } = context;
  const engine = () => services.engine;
  const hostId = loadHostId(config.dataDir);
  const fallbackName = computerName();
  const hostName = async () =>
    (await services.settings?.get("host.displayName"))?.value || (await fallbackName);
  const record = (level: "info" | "warn") => (message: string, fields: Record<string, unknown>) =>
    log.log(level, message, logFields(Object.entries(fields)));

  const threads = new TargetThreads({
    store,
    engine,
    models: () => services.models,
    journal: () => services.agentControl?.delegations.journal,
    now,
    limit: () => services.childLimit?.current(),
    schedule,
    report: (error) => log.log("warn", "Machine child not started", logError(error)),
  });
  resources.own(() => threads.close());
  // A raised or cleared limit starts children other machines left waiting here at once.
  const stopFollowing = services.childLimit?.onChange(() => threads.launches.pump());
  if (stopFollowing) resources.own(stopFollowing);
  const guests = new GuestSessions({
    store,
    engine,
    threads,
    chat: async () => {
      if (!services.projects)
        throw new TargetRefusal("unavailable", "Projects are starting on this machine.");
      const project = await services.projects.createChat();
      return { id: project.id, path: project.path };
    },
    newId: randomUUID,
  });
  void services.engine
    ?.ready()
    .then(() => guests.recover())
    .catch((error: unknown) => log.log("warn", "Guest sessions not recovered", logError(error)));
  const grants = new MachineGrantStore(store, now);
  // Turning a capability down stops what it no longer allows at once (ADR 0105).
  resources.own(
    grants.onChange(({ deviceId, capability, level }) => {
      if (level !== "operate") guests.revoke({ deviceId, capability, level });
    }),
  );
  resources.own(store.devices.onRevoke((deviceId) => guests.revoke({ deviceId })));
  void services.settings
    ?.subscribe({ keys: ["remote.agentAccess"], scope: {} }, (event) => {
      if (event.type !== "changed") return;
      const entry = event.entries.find((candidate) => candidate.key === "remote.agentAccess");
      if (entry?.value === "off") guests.revoke();
    })
    .then((release) => resources.own(release))
    .catch((error: unknown) => log.log("warn", "Agent access not followed", logError(error)));
  services.engine?.bindExternalTaskStop("ace-guest:", (id) => guests.stop(id));
  const browser = new TargetBrowser({ store, browser: () => services.browser, guests });
  const devices = new TargetDevices({
    devices: () => services.devices,
    guestMachine: (threadId) => store.getThread(ThreadId.parse(threadId))?.details?.guest?.name,
  });
  resources.own(devices.follow(guests));
  services.machineCalls = createMachineTarget({
    hostId,
    hostName,
    access: async () => (await services.settings?.get("remote.agentAccess"))?.value ?? "off",
    engine,
    threads,
    browser,
    guests,
    grants,
    hosts: {
      devices,
      screen: unservedHost(() => services.screen !== undefined),
      commands: unservedHost(() => true),
    },
    log: record("info"),
  });

  const directory = new MachineDirectory({
    profiles: () => {
      const profiles = new Profiles(config.dataDir);
      try {
        return profiles.list();
      } finally {
        profiles.close();
      }
    },
    transport: options.machines?.transport ?? machineRequest,
    transfers: async (profile) =>
      new TransferClient(options.transfers?.transport ?? transferTransport, profile).probe(),
    log: record("info"),
    // Sim tools are offered here while a linked machine lends its devices, even with ours off.
    served: () => services.mcp?.toolsChanged(),
  });
  // Settings' links to other machines (`fleet.request`), checked through the same directory.
  services.fleet = new FleetLinks({
    profiles: () => new Profiles(config.dataDir),
    describe: async (profile) =>
      MachineDescription.parse(
        await directory.call(
          profile,
          {
            hostId: HostId.parse(hostId),
            hostName: ((await hostName()) || "ace").slice(0, 256),
            threadId: ThreadId.parse("settings"),
            threadTitle: "Settings",
            ceiling: "operate",
          },
          { op: "describe" },
          { timeoutMs: 4000 },
        ),
      ),
    redeem: options.machines?.redeem ?? redeemPairing,
    hostName,
    transfers: (profile) =>
      new TransferClient(options.transfers?.transport ?? transferTransport, profile).probe(),
  });
  const pollMs = options.machines?.pollMs ?? 1000;
  let caller: MachineCaller | undefined;
  const mirror = new RequestMirror({
    store,
    engine,
    respond: async (entry, resolution) => {
      if (!caller) throw new Error("Machine calls are not ready");
      await caller.respond(entry, resolution);
    },
    log: record("warn"),
  });
  const children = new MachineChildren({
    store,
    engine,
    now,
    schedule,
    pollMs,
    status: async (machine, parent, ids) => {
      if (!caller) throw new Error("Machine calls are not ready");
      return caller.status(machine, parent, ids);
    },
    resend: async (machine, parent, child, message) => {
      if (!caller) throw new Error("Machine calls are not ready");
      return caller.resend(machine, parent, child, message);
    },
    mirror,
    label: (machine) => directory.label(machine),
    host: (machine) => directory.host(machine),
    deliver: (parentThreadId, key, text) => {
      const parent = store.getThread(parentThreadId);
      if (!parent || parent.deletedAt !== undefined) return;
      // Not ready yet is a failure the poll retries, never a delivery.
      const delegations = services.agentControl?.delegations;
      if (!delegations) throw new Error("Agent control is not ready");
      const result = delegations.command(`machine-result:${key}`, {
        type: "thread.send",
        threadId: parentThreadId,
        input: [{ type: "text", text }],
        delivery: "queue",
        trigger: "subagent_result",
        origin: { kind: "subagent_result" },
      });
      if (!result.ok) throw new Error(result.error ?? "Result delivery refused");
    },
    waiting: (id) => services.agentControl?.delegations.monitor.watching(id) ?? false,
    isDescendant: (child, ancestor) =>
      services.agentControl?.delegations.journal.isDescendant(child, ancestor) ?? false,
    descendants: (thread) =>
      services.agentControl?.delegations.journal.descendants(thread).map((edge) => edge.childId) ??
      [],
    device: (machine) => directory.device(machine),
    log: record("warn"),
  });
  resources.own(() => children.close());
  resources.onShutdown(() => children.close());
  caller = new MachineCaller({
    store,
    hostId,
    hostName,
    directory,
    children,
    mirror,
    schedule,
    pollMs,
    ceiling: (threadId) => (services.engine?.access(threadId) === "read-only" ? "read" : "operate"),
  });
  const machines = caller;
  const cancel = (id: string) => {
    const child = children.child(id);
    if (!child || child.settled) return;
    void machines
      .cancel(ThreadId.parse(id))
      .catch((error: unknown) => log.log("warn", "Machine child not stopped", logError(error)));
  };
  services.engine?.bindHostInteractions(
    (command) => mirror.resolve(command) ?? children.resolve(command),
  );
  services.engine?.bindExternalTaskStop("ace-machine:", cancel);
  const delegations = services.agentControl?.delegations;
  if (delegations) {
    delegations.monitor.attachRemote(children);
    delegations.onRemoteCancel = (thread) => {
      for (const id of children.under(thread)) cancel(id);
    };
    // The person's Stop on a thread another machine delegated here cancels its waiting launch.
    delegations.onStopped = (thread) => {
      threads.launches.cancel(thread);
      guests.stopThread(thread);
    };
  }
  services.machines = { caller, children };
}
