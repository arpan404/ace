import type { ClientCore } from "@ace/client";
import {
  Device,
  DeviceId,
  FleetLink,
  RemoteNetworks,
  type FleetOperation,
  type FleetOutcome,
} from "@ace/protocol";
import { z } from "zod";

/*
 * One machine's part of the phone's Fleet map, read on that machine's own runtime: its remote
 * access switches, the networks it reports, the machines it links to and the devices paired
 * with it. Each read stands alone, so a refusal (no administrator access, an older daemon)
 * leaves only its own field empty. `fleet-map.ts` puts the parts together.
 */

export const FleetMapPartRequest = z.object({ type: z.literal("fleetMap.part") });

const Switch = z.boolean().nullable();
export const FleetMapPart = z.object({
  type: z.literal("fleetMap.part"),
  /** The settings: null while they couldn't be read. */
  remote: z.object({ enabled: Switch, lan: Switch, tailscale: Switch }),
  /** What it serves now; null when it couldn't say. */
  networks: RemoteNetworks.nullable(),
  links: z.array(FleetLink).max(64).nullable(),
  devices: z.array(Device).max(500).nullable(),
  /** The device this phone is there. */
  selfId: DeviceId.nullable(),
});
export type FleetMapPart = z.infer<typeof FleetMapPart>;

const quiet = { timeoutMs: 15_000 };
const Entries = z.object({
  ok: z.boolean().optional(),
  entries: z.array(z.object({ value: z.unknown() })).optional(),
});

type Owner = Pick<ClientCore, "request">;

export async function readFleetMapPart(owner: Owner, signal: AbortSignal): Promise<FleetMapPart> {
  const setting = async (key: string): Promise<boolean | null> => {
    try {
      const reply = Entries.parse(
        await owner.request({ type: "settings.get", key, scope: {} }, { ...quiet, signal }),
      );
      const value = reply.ok === false ? undefined : reply.entries?.[0]?.value;
      return typeof value === "boolean" ? value : null;
    } catch {
      return null;
    }
  };
  const fleet = async <T>(operation: FleetOperation, pick: (outcome: FleetOutcome) => T | null) => {
    try {
      const reply = await owner.request({ type: "fleet.request", operation }, { ...quiet, signal });
      return pick(reply.result);
    } catch {
      return null;
    }
  };
  const [enabled, lan, tailscale, networks, links, devices] = await Promise.all([
    setting("remote.enabled"),
    setting("remote.lan"),
    setting("remote.tailscale"),
    fleet({ op: "remoteStatus" }, (outcome) =>
      outcome.kind === "remoteStatus" ? (outcome.status.networks ?? null) : null,
    ),
    fleet({ op: "links" }, (outcome) => (outcome.kind === "links" ? outcome.links : null)),
    fleet({ op: "devices" }, (outcome) =>
      outcome.kind === "devices" ? { list: outcome.devices, selfId: outcome.selfId ?? null } : null,
    ),
  ]);
  return {
    type: "fleetMap.part",
    remote: { enabled, lan, tailscale },
    networks,
    links: links?.slice(0, 64) ?? null,
    devices: devices?.list.slice(0, 500) ?? null,
    selfId: devices?.selfId ?? null,
  };
}
