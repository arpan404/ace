import type { ClientCore } from "@ace/client";
import { SettingsValues, type OutsideEndpoint, type SettingsKey } from "@ace/protocol";
import { endpointNames, enrollCommand } from "@ace/ui-core";
import { z } from "zod";

/*
 * Settings › a machine › Connect an app, as web's page has it (ADR 0122): the four addresses an
 * outside client can use, each with what it can copy, its own on/off where it has one, and why
 * it can't serve; then the command a terminal agent's person runs. The relay and Tailscale
 * switches and your own URL are the machine's settings (`remote.relayMcp`, `remote.tailscaleMcp`,
 * `remote.mcpPublicUrl`). Refusals throw, for `answerOutside` to say in words.
 */

type Owner = Pick<ClientCore, "request">;
const quiet = { timeoutMs: 15_000 };

export const AddressOps = [
  z.object({ op: z.literal("addresses") }),
  z.object({ op: z.literal("setPath"), path: z.enum(["relay", "tailscale"]), on: z.boolean() }),
  z.object({ op: z.literal("setPublicUrl"), url: z.string().max(2048).nullable() }),
] as const;

const order: readonly OutsideEndpoint["path"][] = ["local", "tailscale", "relay", "custom"];
/** Said once, on the relay's row (ADR 0122, Reach). */
const relayTrust = "ace cloud can read what passes through it; it keeps none of it.";
const switches = { relay: "remote.relayMcp", tailscale: "remote.tailscaleMcp" } as const;
const ownUrlKey = "remote.mcpPublicUrl";

/** A setting the phone typed that the machine wouldn't take, in the setting's own words. */
export class AddressRefused extends Error {}

const Entries = z.object({ entries: z.array(z.object({ value: z.unknown() })).optional() });
async function setting(owner: Owner, key: SettingsKey): Promise<unknown> {
  const reply = await owner.request({ type: "settings.get", key, scope: {} }, quiet);
  return Entries.parse(reply).entries?.[0]?.value;
}
async function save(owner: Owner, key: SettingsKey, value: boolean | string | null) {
  const reply = await owner.request(
    { type: "settings.set", key, value, layer: { kind: "global" } },
    quiet,
  );
  if (!reply.ok) throw new AddressRefused("This machine didn't save that change.");
}

export async function readAddresses(owner: Owner) {
  const [outcome, relay, tailscale, own] = await Promise.all([
    owner.request({ type: "outside.request", operation: { op: "endpoints" } }, quiet),
    setting(owner, switches.relay),
    setting(owner, switches.tailscale),
    setting(owner, ownUrlKey),
  ]);
  const endpoints = outcome.result.kind === "endpoints" ? outcome.result.endpoints : [];
  const byPath = new Map(endpoints.map((endpoint) => [endpoint.path, endpoint]));
  const on = { relay: relay === true, tailscale: tailscale === true };
  return {
    ok: true,
    rows: order.map((path) => {
      const endpoint = byPath.get(path);
      const url = endpoint && !endpoint.problem ? endpoint.url : null;
      return {
        path,
        title: endpointNames[path],
        /** What Copy copies: only an address that serves. */
        url,
        /** The address, why it can't serve, or Off; null when the machine didn't say. */
        state: endpoint ? (endpoint.problem ?? endpoint.url ?? "Off") : null,
        problem: !!endpoint?.problem,
        note: path === "relay" ? relayTrust : null,
        /** The path's own switch; null for paths without one. */
        on: path === "relay" || path === "tailscale" ? on[path] : null,
        /** Your own URL as saved, for Change and Remove. */
        ownUrl: path === "custom" && typeof own === "string" ? own : null,
      };
    }),
    enroll: enrollCommand,
  };
}

export async function setAddressPath(owner: Owner, path: keyof typeof switches, on: boolean) {
  await save(owner, switches[path], on);
  return { ok: true };
}

export async function setOwnUrl(owner: Owner, url: string | null) {
  const parsed = SettingsValues.shape[ownUrlKey].safeParse(url === null ? null : url.trim());
  if (!parsed.success)
    throw new AddressRefused(
      parsed.error.issues[0]?.message ?? "Use an https origin, such as https://ace.example.com",
    );
  await save(owner, ownUrlKey, parsed.data);
  return { ok: true };
}
