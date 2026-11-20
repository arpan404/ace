import { useClient, useSidebarIndex } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import { HostId, type DeviceContextItem, type ThreadListEntry } from "@ace/protocol";
import { AppDevice } from "@ace/protocol/devices";
import {
  agentDetail,
  botDetail,
  clubDetail,
  deviceDetail,
  hostPlatform,
  type PickerAgent,
  type PickerDevice,
} from "@ace/ui-core";
import { deviceKind as pairedKind, machineKind } from "@ace/ui-core/fleet-map";
import type { SpadeAgent, SpadeAvatar, SpadeGroup } from "@ace/ui-core/spade-chat";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { channelEndpoint } from "@/boot/main-machine.ts";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useDeviceSession } from "@/features/devices/index.ts";
import { machineDevices } from "@/features/settings/index.ts";
import { useSpadeMentions } from "@/lib/spade-mentions.tsx";
import { useHostIdentity } from "@/lib/host-name.ts";
import { useMachines, type Machine } from "@/lib/machines.ts";
import { useClock } from "@/lib/time.ts";

/*
 * What the `@` picker lists besides files (ADR 0198), each read from the module that already owns
 * it and only while the picker is open: other threads' agents from the sidebar index, Spade bots
 * and clubs from each online machine's Spade (the same reads Spade's own panel makes), and the
 * fleet's machines, their paired phones and each machine's simulators and emulators.
 */

/** The person's other machine a bot or club lives on; absent for this machine's. */
export interface MentionElsewhere {
  id: HostId;
  name: string;
}
export interface MentionBot {
  id: string;
  name: string;
  detail: string;
  avatar: SpadeAvatar;
  machine?: MentionElsewhere | undefined;
}
export interface MentionClub {
  id: string;
  name: string;
  detail: string;
  members: { agent: string; avatar: SpadeAvatar; away: boolean }[];
  machine?: MentionElsewhere | undefined;
}
export interface MentionAgent extends PickerAgent {
  detail: string;
}
export interface MentionDevice extends PickerDevice {
  detail: string;
  item: DeviceContextItem;
}

const agentRow = (thread: ReturnType<typeof threadFacts>): PickerAgent | undefined => {
  const state = thread.status.state;
  if (state !== "working" && state !== "needs_you") return undefined;
  return {
    threadId: thread.id,
    title: thread.title || "Untitled thread",
    provider: thread.provider,
    state: state === "working" ? "working" : "waiting",
  };
};
const threadFacts = (thread: ThreadListEntry) => ({
  id: thread.id,
  title: thread.title,
  provider: thread.provider,
  status: thread.status,
  workspaceId: thread.workspaceId,
});
const sameFacts = (a: ReturnType<typeof threadFacts>, b: ReturnType<typeof threadFacts>) =>
  a.id === b.id &&
  a.title === b.title &&
  a.status.state === b.status.state &&
  a.workspaceId === b.workspaceId;

const osWords: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

function deviceRow(device: PickerDevice): MentionDevice {
  const item: DeviceContextItem = {
    type: "device",
    id: device.id,
    name: device.name,
    kind: device.kind,
    machine: device.machine,
    ...(device.os ? { os: device.os } : {}),
    ...(device.model ? { model: device.model } : {}),
    online: device.online,
  };
  return { ...device, detail: deviceDetail(device), item };
}

const DeviceList = z.object({ devices: z.array(z.unknown()).max(1024).catch([]) });

/**
 * Another machine's simulators, emulators and phones, from its own devices (data from outside:
 * each read leniently); none when it can't say.
 */
async function machineSimulators(client: ClientApi): Promise<AppDevice[]> {
  const reply = await client.request({ type: "devices.request", operation: { op: "list" } });
  if (!reply.ok) return [];
  return (DeviceList.safeParse(reply.data).data?.devices ?? [])
    .flatMap((device) => {
      const read = AppDevice.safeParse(device);
      return read.success ? [read.data] : [];
    })
    .slice(0, 64);
}

/** A simulator, emulator or phone a machine's devices list, as a picker row. */
function appRow(device: AppDevice, machine: PickerDevice["machine"]): PickerDevice {
  const physical = device.serial !== undefined && device.platform === "android";
  return {
    id: device.id,
    name: device.name,
    kind: physical ? "phone" : device.platform === "ios" ? "simulator" : "emulator",
    machine,
    os: device.runtime,
    model: physical ? undefined : device.name,
    online: device.state === "booted",
  };
}

/** A bot as a picker row; one on another machine says which in its line. */
function botRow(bot: SpadeAgent, where?: MentionElsewhere): MentionBot {
  const detail = botDetail({
    id: bot.id,
    name: bot.name,
    task: bot.task,
    main: bot.kind === "main",
  });
  return {
    id: bot.id,
    name: bot.name,
    avatar: bot.avatar,
    detail: where ? `${detail} · on ${where.name}` : detail,
    ...(where ? { machine: where } : {}),
  };
}

/** A club as a picker row; one on another machine says which in its line. */
function clubRow(club: SpadeGroup, where?: MentionElsewhere): MentionClub {
  const detail = clubDetail({
    id: club.id,
    name: club.name,
    members: club.members.map((m) => m.name),
  });
  return {
    id: club.id,
    name: club.name,
    detail: where ? `${detail} · on ${where.name}` : detail,
    members: club.members.map((member) => ({
      agent: member.agent,
      avatar: member.avatar,
      away: member.away,
    })),
    ...(where ? { machine: where } : {}),
  };
}

/** Every machine of the fleet, this one first, then their paired devices and simulators. */
export function useMentionDevices(open: boolean): MentionDevice[] {
  return useDevices(open, useMachines());
}

function useDevices(open: boolean, machines: readonly Machine[]): MentionDevice[] {
  const identity = useHostIdentity();
  const now = useClock()();
  const { endpoint } = useDaemonConnection();
  const { session, snapshot } = useDeviceSession(open ? channelEndpoint(endpoint) : undefined);
  useEffect(() => {
    if (!session || !snapshot.connected) return;
    void session.client.request({ op: "list" }).catch(() => undefined);
  }, [session, snapshot.connected]);
  const paired = useQueries({
    queries: machines.map((machine) => ({
      queryKey: ["mentions", "paired", machine.id],
      queryFn: () => (machine.client ? machineDevices(machine.client) : Promise.resolve([])),
      enabled: open && machine.client !== undefined,
      staleTime: 30_000,
      retry: false,
    })),
  });
  const simulators = useQueries({
    queries: machines.map((machine) => ({
      queryKey: ["mentions", "simulators", machine.id],
      queryFn: () => (machine.client ? machineSimulators(machine.client) : Promise.resolve([])),
      enabled: open && !machine.primary && machine.client !== undefined,
      staleTime: 30_000,
      retry: false,
    })),
  });
  const here = machines.find((machine) => machine.primary);
  const hereRef = here && {
    id: identity?.hostId ?? here.id,
    name: identity?.displayName ?? here.name,
    here: true,
  };
  const rows: PickerDevice[] = [];
  for (const machine of machines) {
    const ref =
      machine.primary && hereRef ? hereRef : { id: machine.id, name: machine.name, here: false };
    const platform = machine.primary ? hostPlatform(identity?.platform) : undefined;
    rows.push({
      id: ref.id,
      name: ref.name,
      kind: (() => {
        const kind = machineKind({ icon: machine.icon?.kind, name: machine.name, platform });
        return kind === "phone" ? "phone" : kind;
      })(),
      machine: ref,
      os: platform ? osWords[platform] : undefined,
      online: machine.status === "online",
    });
  }
  if (hereRef) for (const device of snapshot.devices) rows.push(appRow(device, hereRef));
  // Each other machine's simulators and emulators, as its own devices list them.
  machines.forEach((machine, index) => {
    if (machine.primary) return;
    const ref = { id: machine.id, name: machine.name, here: false };
    for (const device of simulators[index]?.data ?? []) rows.push(appRow(device, ref));
  });
  machines.forEach((machine, index) => {
    const ref =
      machine.primary && hereRef ? hereRef : { id: machine.id, name: machine.name, here: false };
    for (const device of paired[index]?.data ?? []) {
      if (device.self || device.revokedAt !== null) continue;
      const kind = pairedKind(device.name);
      if (kind === "browser") continue;
      rows.push({
        id: device.id,
        name: device.name,
        kind,
        machine: ref,
        // Seen in the last ten minutes: it answers.
        online: now - device.lastSeenAt < 10 * 60_000,
      });
    }
  });
  return rows.map(deviceRow);
}

/**
 * The picker's agents, bots, clubs and devices while it is open; nothing is read while it is
 * closed. A source that can't be read (Spade off, a machine away) lists nothing, never an error.
 */
export function useMentionSources(input: {
  open: boolean;
  threadId: string | undefined;
  workspaceId: string;
}) {
  const { open } = input;
  const client = useClient();
  const machines = useMachines();
  const threads = useSidebarIndex(threadFacts, sameFacts) ?? [];
  const agents: MentionAgent[] = threads.flatMap((thread) => {
    if (thread.id === input.threadId || thread.workspaceId !== input.workspaceId) return [];
    const agent = agentRow(thread);
    return agent ? [{ ...agent, detail: agentDetail(agent) }] : [];
  });
  const spade = useSpadeMentions();
  const bots = useQuery({
    queryKey: ["mentions", "spade", "bots"],
    queryFn: ({ signal }) => spade?.readBots(client, signal) ?? Promise.resolve([]),
    enabled: open && !!spade,
    staleTime: 10_000,
    retry: false,
  });
  const clubs = useQuery({
    queryKey: ["mentions", "spade", "clubs"],
    queryFn: ({ signal }) => spade?.readClubs(client, signal) ?? Promise.resolve([]),
    enabled: open && !!spade,
    staleTime: 10_000,
    retry: false,
  });
  // The person's other machines, online now, with a host id an ask can name.
  const others = machines.flatMap((machine) => {
    const id = HostId.safeParse(machine.id);
    return !machine.primary && machine.client && id.success
      ? [{ client: machine.client, where: { id: id.data, name: machine.name } }]
      : [];
  });
  const elsewhere = useQueries({
    queries: others.map((other) => ({
      queryKey: ["mentions", "spade", "elsewhere", other.where.id],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        if (!spade) return { bots: [], clubs: [] };
        const [listed, clubsThere] = await Promise.all([
          spade.readBots(other.client, signal).catch(() => []),
          spade.readClubs(other.client, signal).catch(() => []),
        ]);
        return { bots: listed, clubs: clubsThere };
      },
      enabled: open && !!spade,
      staleTime: 10_000,
      retry: false,
    })),
  });
  const devices = useDevices(open, machines);
  return {
    agents,
    bots: [
      ...(bots.data ?? []).map((bot) => botRow(bot)),
      // Another machine's own bots; its main Spade is the one Spade, listed once above.
      ...others.flatMap((other, index) =>
        (elsewhere[index]?.data?.bots ?? [])
          .filter((bot) => bot.kind !== "main")
          .map((bot) => botRow(bot, other.where)),
      ),
    ],
    clubs: [
      ...(clubs.data ?? []).map((club) => clubRow(club)),
      ...others.flatMap((other, index) =>
        (elsewhere[index]?.data?.clubs ?? []).map((club) => clubRow(club, other.where)),
      ),
    ],
    devices,
  };
}
