import type { RemoteListener } from "./network.ts";
import type { DirectPlan } from "./remote-policy.ts";

export type DirectNetwork = "lan" | "tailscale";
/** A network's address, or why it couldn't be read. */
export type Resolved = RemoteListener | Error;

export interface DirectTarget {
  /** The address the listener binds. */
  host: string;
  port: number;
  identity: RemoteListener["identity"];
  /** The address links name. */
  advertisedHost: string;
  tailnetName?: string;
  serves: DirectPlan;
}

const usable = (read: Resolved | undefined): RemoteListener | undefined =>
  read && !(read instanceof Error) ? read : undefined;

/**
 * The one listener LAN and Tailscale share. The LAN binds every address, which reaches the
 * Tailscale address too, so with both up it binds as the LAN does and links name Tailscale, which
 * also works away from the LAN. Undefined when neither network can serve.
 */
export function directAdvertisement(
  resolution: Partial<Record<DirectNetwork, Resolved>>,
): DirectTarget | undefined {
  const lan = usable(resolution.lan);
  const tailscale = usable(resolution.tailscale);
  const bind = lan ?? tailscale;
  if (!bind) return undefined;
  const named = tailscale ?? lan ?? bind;
  return {
    host: bind.host,
    port: bind.port,
    identity: bind.identity,
    advertisedHost: named.advertisedHost,
    ...(tailscale?.tailnetName ? { tailnetName: tailscale.tailnetName } : {}),
    serves: { lan: lan !== undefined, tailscale: tailscale !== undefined },
  };
}
