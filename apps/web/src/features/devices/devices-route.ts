import type { DaemonTarget } from "@/boot/connection-settings.ts";
import { isLoopbackUrl } from "@/boot/fragment-handoff.ts";

/**
 * How the devices channel reaches a daemon. A machine paired through a relay is reached only
 * through its end-to-end encrypted channel, pinned to its host key: `url` is the relay's
 * address, so neither the token in a header nor a plain hello may ever go there.
 */
export type DevicesRoute =
  | { kind: "direct" }
  | { kind: "direct-then-relay" }
  | { kind: "relay"; url: string; hostId: string };

export function devicesRoute(
  target: Pick<DaemonTarget, "url" | "pairedDeviceId" | "relayHostId">,
): DevicesRoute {
  if (target.relayHostId) return { kind: "relay", url: target.url, hostId: target.relayHostId };
  if (isLoopbackUrl(target.url) || !target.pairedDeviceId) return { kind: "direct" };
  return { kind: "direct-then-relay" };
}
