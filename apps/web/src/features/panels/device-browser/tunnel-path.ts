import type { MachineEntry } from "@ace/client/machines";
import type { MachinePathKind } from "@ace/protocol";

/** What the desktop's main process needs to open a machine's tunnel on one path. */
export interface TunnelPathRequest {
  key: string;
  target: { kind: "direct"; url: string } | { kind: "relay"; url: string; hostId: string };
  deviceId: string;
  token: string;
}

const socketUrl = (url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  return parsed.toString();
};

/**
 * The path a remote machine's tunnel opens on (ADR 0194): the one its connection uses now when
 * the machine said it serves it, else the path it was paired on. Undefined while the machine
 * isn't online, and for a machine reached only through the person's ace account, whose grants
 * the tunnel can't use yet. Pure.
 */
export function tunnelPathFor(machine: {
  entry: MachineEntry;
  online: boolean;
  path: MachinePathKind | undefined;
  token: string | undefined;
}): TunnelPathRequest | undefined {
  const { entry, token } = machine;
  if (!machine.online || !token || entry.target.kind === "account") return undefined;
  const base = { deviceId: entry.deviceId, token };
  const now = machine.path && entry.paths?.find((path) => path.kind === machine.path);
  if (now && now.kind !== "account") {
    const url = socketUrl(now.url);
    return "relayHostId" in now
      ? { ...base, key: `relay:${url}`, target: { kind: "relay", url, hostId: now.relayHostId } }
      : { ...base, key: `${now.kind}:${url}`, target: { kind: "direct", url } };
  }
  const url = socketUrl(entry.target.url);
  return entry.target.kind === "relay"
    ? {
        ...base,
        key: `relay:${url}`,
        target: { kind: "relay", url, hostId: entry.target.ticketReference },
      }
    : { ...base, key: `direct:${url}`, target: { kind: "direct", url } };
}
