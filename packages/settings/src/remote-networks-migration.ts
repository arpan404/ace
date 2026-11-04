import type { SettingsValues } from "@ace/protocol";

type Transport = SettingsValues["remote.transport"];
export type RemoteNetworkChoice = Pick<
  SettingsValues,
  "remote.lan" | "remote.tailscale" | "remote.relay"
>;

/**
 * What a `remote.transport` choice meant before networks ran together (ADR 0112): `local` and
 * `lan` listened on the LAN, `tailscale` on Tailscale only, `relay` on the LAN plus the relay. A
 * saved relay address always ran its relay, whatever the transport.
 */
export function transportNetworks(transport: Transport, relayUrl: string): RemoteNetworkChoice {
  return {
    "remote.lan": transport !== "tailscale",
    "remote.tailscale": transport === "tailscale",
    "remote.relay": transport === "relay" || relayUrl !== "",
  };
}

/**
 * The network settings a document gains, or undefined when it needs none. A stored
 * `remote.transport` (an older daemon's file, or an older app's write) always becomes the three
 * settings and is removed. A relay address saved before any network setting existed keeps its
 * relay running. Portable: no Node imports.
 */
export function remoteNetworksMigration(settings: {
  readonly "remote.transport"?: Transport | undefined;
  readonly "remote.relayUrl"?: string | undefined;
  readonly "remote.lan"?: boolean | undefined;
  readonly "remote.tailscale"?: boolean | undefined;
  readonly "remote.relay"?: boolean | undefined;
}): { networks: RemoteNetworkChoice; dropTransport: boolean } | undefined {
  const relayUrl = settings["remote.relayUrl"] ?? "";
  const transport = settings["remote.transport"];
  if (transport !== undefined)
    return { networks: transportNetworks(transport, relayUrl), dropTransport: true };
  const chosen =
    settings["remote.lan"] !== undefined ||
    settings["remote.tailscale"] !== undefined ||
    settings["remote.relay"] !== undefined;
  if (chosen || relayUrl === "") return undefined;
  return { networks: transportNetworks("lan", relayUrl), dropTransport: false };
}

/** Keys whose writes may change other network settings, so they never take the fast path. */
export function migratesOnWrite(key: string): boolean {
  return key === "remote.transport" || key === "remote.relayUrl";
}
