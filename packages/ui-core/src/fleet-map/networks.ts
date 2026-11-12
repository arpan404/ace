import type { RemoteNetworks } from "@ace/protocol";

/*
 * The networks on the Fleet map, read from addresses: which network an address is on, the
 * subnet a local address names, and the tailnet a Tailscale name belongs to. Pure.
 */

export type DirectWay = "tailscale" | "lan" | "other";

/** The host part of an address ("wss://relay.acehq.dev/x" → "relay.acehq.dev"), else undefined. */
export function hostOf(address: string | undefined): string | undefined {
  if (!address) return undefined;
  try {
    return new URL(address).hostname.replace(/^\[|\]$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

const ipv4 = (host: string) => {
  const parts = host.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : undefined;
};

/**
 * Which network an address this window dials is on: Tailscale's addresses (100.64.0.0/10) and
 * names (*.ts.net), the local network's private ranges and .local names, else another network.
 */
export function directWayOf(address: string): DirectWay {
  const host = hostOf(address)?.toLowerCase();
  if (!host) return "other";
  if (host.endsWith(".ts.net")) return "tailscale";
  const parts = ipv4(host);
  if (parts) {
    const [a = 0, b = 0] = parts;
    if (a === 100 && b >= 64 && b <= 127) return "tailscale";
    if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))
      return "lan";
    if (a === 169 && b === 254) return "lan";
    return "other";
  }
  if (host.endsWith(".local") || host === "localhost") return "lan";
  if (host.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(host)) return "lan";
  return "other";
}

/** "192.168.1.0" for a local IPv4 address; undefined for anything else. */
export function subnetOf(address: string | undefined): string | undefined {
  const parts = ipv4(hostOf(address) ?? "");
  return parts ? `${parts.slice(0, 3).join(".")}.0` : undefined;
}

/** "tail1a2b.ts.net" from a MagicDNS name ("mac.tail1a2b.ts.net"); undefined otherwise. */
export function tailnetOf(address: string | undefined): string | undefined {
  return hostOf(address)
    ?.toLowerCase()
    .match(/([a-z0-9-]+\.ts\.net)$/)?.[1];
}

/** Whether a network reports that it serves now. */
export const serving = (network: { state: string } | undefined) => network?.state === "on";

/** The ways paired devices reach a machine: straight over Tailscale or the LAN, or its relay. */
export function pairedWays(networks: RemoteNetworks): { direct: string[]; relay: boolean } {
  return {
    direct: [
      serving(networks.tailscale) ? "Tailscale" : undefined,
      serving(networks.lan) ? "local network" : undefined,
    ].filter((way) => way !== undefined),
    relay: serving(networks.relay),
  };
}
