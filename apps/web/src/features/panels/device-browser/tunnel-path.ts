import { pinnedFingerprint, type MachineEntry } from "@ace/client/machines";
import type { MachinePathKind } from "@ace/protocol";
import type { TunnelPathRequest } from "@/boot/desktop-device-tabs.ts";
import { dialedPaths } from "@/boot/machine-routes.ts";

export type { TunnelPathRequest };

/**
 * The path a remote machine's tunnel opens on (ADR 0194): the one this window's connection to it
 * is on, among the paths its worker dials and so verifies (`dialedPaths`), with what the tunnel
 * pins there. A direct path needs the listener's public-key fingerprint (the paired one, or the
 * one the machine named for that address); without one the tunnel has no path, since a socket it
 * can't pin would hand the device's credential to whoever answers. While the connection hasn't
 * said which path it is on, only a machine with a single path has one. Undefined while the
 * machine isn't online, and for a machine reached only through the person's ace account, whose
 * grants the tunnel can't use yet. Pure.
 */
export function tunnelPathFor(machine: {
  entry: MachineEntry;
  online: boolean;
  path: MachinePathKind | undefined;
  token: string | undefined;
}): TunnelPathRequest | undefined {
  const { entry, token } = machine;
  if (!machine.online || !token || entry.target.kind === "account") return undefined;
  const target = entry.target;
  const dialed = dialedPaths(
    target.kind === "relay"
      ? { url: target.url, relayHostId: target.ticketReference }
      : { url: target.url },
    entry.paths,
  );
  const now = machine.path
    ? dialed.find((path) => path.kind === machine.path)
    : dialed.length === 1
      ? dialed[0]
      : undefined;
  if (!now) return undefined;
  const base = { expectedHostId: entry.hostId, deviceId: entry.deviceId, token };
  if (now.relayHostId)
    return {
      ...base,
      key: `relay:${now.url}`,
      target: { kind: "relay", url: now.url, hostKey: now.relayHostId },
    };
  const paired = dialed[0] === now && target.kind === "direct" ? target.fingerprint : undefined;
  const fingerprint = paired ?? pinnedFingerprint(now.url, entry.paths);
  // Only TLS can be pinned: a plain `ws:` address has nothing to check the machine by.
  if (!fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint) || !now.url.startsWith("wss:"))
    return undefined;
  return {
    ...base,
    key: `${now.kind}:${now.url}`,
    target: { kind: "direct", url: now.url, fingerprint },
  };
}
