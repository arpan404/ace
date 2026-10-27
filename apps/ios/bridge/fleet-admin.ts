import type { ClientCore } from "@ace/client";
import { DeviceId, HostId } from "@ace/protocol";
import type { FleetOperation, FleetOutcome } from "@ace/protocol";
import {
  advancedPairingScopes,
  deviceAccessLevels,
  deviceLifetimes,
  deviceScopeLabels,
  fleetRefusal,
  fleetRules,
  linkLifetimes,
  linkPairingProblem,
  linkRedeemProblem,
  linkScopes,
  pairedDevices,
  pairingOperation,
} from "@ace/ui-core";
import { z } from "zod";

/*
 * One machine's administration from the phone, as the web's Fleet settings: the machines it
 * links to, the devices paired with it and its unused pairing links; pairing another device
 * with a chosen access and lifetime, cancelling a link, revoking a device, and the two halves
 * of linking two machines (the reached machine issues a link, the other redeems it). Words come
 * from `@ace/ui-core` device-pairing; refusals answer in words, never throw.
 */

const quiet = { timeoutMs: 15_000 };
const Access = z.enum(["operate", "read", "admin"]);
const Extra = z.enum(["projects", "accounts"]);

export const NativeFleetRequest = z.object({
  type: z.literal("native.fleet"),
  /** The machine's name, for words such as "Turn on remote access on studio". */
  machine: z.string().min(1).max(256),
  request: z.discriminatedUnion("op", [
    z.object({ op: z.literal("overview") }),
    /** The fleet-wide rules a person sets on every machine at once. */
    z.object({ op: z.literal("rules") }),
    z.object({
      op: z.literal("pair"),
      access: Access,
      extras: z.array(Extra).max(2).default([]),
      label: z.string().max(256).optional(),
      ttlMs: z.number().int().nonnegative().optional(),
      deviceTtlMs: z.number().int().nonnegative().optional(),
    }),
    z.object({ op: z.literal("cancelPairing"), id: z.string().min(1).max(128) }),
    z.object({ op: z.literal("revoke"), deviceId: DeviceId }),
    z.object({ op: z.literal("revokeOthers") }),
    /** The reached machine's half of a link: a one-time pairing link an agent device redeems. */
    z.object({ op: z.literal("issueLink"), access: z.enum(["read", "operate"]) }),
    /** The other half: redeem that link and keep it as a link to `name`. */
    z.object({
      op: z.literal("redeemLink"),
      pairingUrl: z.string().min(1).max(4096),
      hostId: HostId,
      name: z.string().min(1).max(256),
    }),
    z.object({ op: z.literal("unlink"), hostId: HostId }),
  ]),
});
export type NativeFleetRequest = z.infer<typeof NativeFleetRequest>;

export type FleetOwner = Pick<ClientCore, "request">;

/** A refusal's code: the daemon's own (carried as the message of a `daemon` error), else the client's. */
export function refusalCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unavailable";
  const code = String(error.code);
  return code === "daemon" && error instanceof Error ? error.message : code;
}

/** The pairing form's fixed choices, in the web's words. */
const choices = {
  access: deviceAccessLevels.map(({ value, label, description }) => ({
    id: value,
    label,
    note: description,
  })),
  extras: advancedPairingScopes.map(({ value, label, what }) => ({ id: value, label, note: what })),
  linkLifetimes: linkLifetimes.map(({ value, label }) => ({ value, label })),
  deviceLifetimes: deviceLifetimes.map(({ value, label }) => ({ value, label })),
};

const refused = (code: string, message: string) => ({ ok: false as const, code, message });

export async function answerFleet(owner: FleetOwner, input: NativeFleetRequest): Promise<unknown> {
  const { machine, request } = input;
  const ask = async (operation: FleetOperation): Promise<FleetOutcome> =>
    (await owner.request({ type: "fleet.request", operation }, quiet)).result;
  try {
    switch (request.op) {
      case "overview":
        return await overview(ask, machine);
      case "rules":
        return { ok: true, rules: fleetRules };
      case "pair": {
        const ttl = linkLifetimes.find((entry) => entry.value === request.ttlMs)?.value;
        const keeps = deviceLifetimes.find((entry) => entry.value === request.deviceTtlMs)?.value;
        const result = await ask(
          pairingOperation({
            access: request.access,
            extras: request.extras,
            label: request.label,
            ttlMs: ttl,
            deviceTtlMs: keeps,
          }),
        );
        if (result.kind !== "pairing")
          return refused("unavailable", `${machine} didn't make a pairing.`);
        return {
          ok: true,
          id: result.id,
          url: result.url,
          code: result.code,
          expiresAt: result.expiresAt,
        };
      }
      case "cancelPairing":
        await ask({ op: "cancelPairing", id: request.id });
        return { ok: true };
      case "revoke":
        await ask({ op: "revoke", deviceId: request.deviceId });
        return { ok: true };
      case "revokeOthers": {
        const result = await ask({ op: "revokeOthers" });
        return { ok: true, count: result.kind === "revoked" ? (result.count ?? 0) : 0 };
      }
      case "issueLink": {
        const result = await ask({ op: "pairing", scopes: linkScopes(request.access) }).catch(
          (error: unknown) => {
            throw new Refusal(refusalCode(error), linkPairingProblem(refusalCode(error), machine));
          },
        );
        if (result.kind !== "pairing")
          return refused("unavailable", linkPairingProblem("", machine));
        return { ok: true, url: result.url };
      }
      case "redeemLink": {
        const result = await ask({
          op: "link",
          pairingUrl: request.pairingUrl,
          hostId: request.hostId,
          name: request.name,
        }).catch((error: unknown) => {
          const code = refusalCode(error);
          throw new Refusal(code, linkRedeemProblem(code, machine, request.name));
        });
        if (result.kind !== "linked")
          return refused("unavailable", `${machine} didn't keep the link.`);
        return { ok: true };
      }
      case "unlink":
        await ask({ op: "unlink", hostId: request.hostId });
        return { ok: true };
    }
  } catch (error) {
    if (error instanceof Refusal) return refused(error.code, error.message);
    const code = refusalCode(error);
    return refused(code, fleetRefusal(code, machine));
  }
}

class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const lifetime = (ms: number | undefined) =>
  deviceLifetimes.find((entry) => entry.value === (ms ?? 0))?.label;

/** Links, devices and open pairing links, each read on its own so one refusal hides only itself. */
async function overview(
  ask: (operation: FleetOperation) => Promise<FleetOutcome>,
  machine: string,
) {
  const read = async <T>(operation: FleetOperation, pick: (outcome: FleetOutcome) => T) => {
    try {
      return { ok: true as const, value: pick(await ask(operation)) };
    } catch (error) {
      const code = refusalCode(error);
      return { ok: false as const, code, message: fleetRefusal(code, machine) };
    }
  };
  const [links, devices, pairings] = await Promise.all([
    read({ op: "links" }, (outcome) => (outcome.kind === "links" ? outcome.links : [])),
    read({ op: "devices" }, (outcome) =>
      outcome.kind === "devices" ? { devices: outcome.devices, selfId: outcome.selfId } : undefined,
    ),
    read({ op: "pairings" }, (outcome) => (outcome.kind === "pairings" ? outcome.pairings : [])),
  ]);
  return {
    ok: true,
    choices,
    // Nothing is readable without administrator access: say it once.
    forbidden: [links, devices, pairings].every((entry) => !entry.ok && entry.code === "forbidden"),
    links: links.ok
      ? links.value.slice(0, 64).map((link) => ({
          hostId: link.hostId ?? null,
          name: link.name,
          profile: link.profile,
          status: link.status,
          deviceId: link.deviceId,
          line: [
            link.status === "online"
              ? "Online"
              : link.status === "offline"
                ? "Offline"
                : "Refuses agents",
            link.access === "operate"
              ? "Agents can act"
              : link.access === "read"
                ? "Agents can read"
                : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
        }))
      : [],
    linksProblem: links.ok ? null : links.message,
    devices:
      devices.ok && devices.value
        ? pairedDevices(devices.value.devices)
            .slice(0, 500)
            .map((device) => ({
              id: device.id,
              name: device.name,
              self: device.id === devices.value?.selfId,
              access: deviceScopeLabels(device.scopes),
              lastSeenAt: device.lastSeenAt,
              expiresAt: device.expiresAt ?? null,
            }))
        : [],
    devicesProblem: devices.ok ? null : devices.message,
    pairings: pairings.ok
      ? pairings.value.slice(0, 100).map((pairing) => ({
          id: pairing.id,
          label: pairing.label ?? "Pairing link",
          line: [
            deviceScopeLabels(pairing.scopes),
            pairing.deviceTtlMs
              ? `access for ${lifetime(pairing.deviceTtlMs) ?? "a while"}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
          expiresAt: pairing.expiresAt,
        }))
      : [],
    pairingsProblem: pairings.ok ? null : pairings.message,
  };
}
