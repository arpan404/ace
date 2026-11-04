import type { RemoteAccessStatus, RemoteNetworkStatus } from "@ace/protocol";

const hostedRelay = "wss://relay.acehq.dev";

const state = (on: boolean, address: string): RemoteNetworkStatus =>
  on ? { state: "on", address } : { state: "off" };

/**
 * Remote access as the daemon reports it from its settings: every network turned on serves,
 * with no outages. The fake machine is signed out, so ace's relay runs only when the relay is
 * turned on with no address, and then waits for a sign-in.
 */
export function fakeRemoteStatus(get: (key: string) => unknown): RemoteAccessStatus {
  const enabled = get("remote.enabled") === true;
  const lan = enabled && get("remote.lan") === true;
  const tailscale = enabled && get("remote.tailscale") === true;
  const relayOn = enabled && get("remote.relay") === true;
  const own = typeof get("remote.relayUrl") === "string" ? String(get("remote.relayUrl")) : "";
  const relay: RemoteNetworkStatus = !relayOn
    ? { state: "off" }
    : own
      ? { state: "on", address: own }
      : {
          state: "waiting",
          error: "Sign in to your ace account on this machine to use ace's relay.",
          address: hostedRelay,
        };
  const relayServing = relay.state === "on";
  return {
    enabled: lan || tailscale || relayServing,
    transport: relayServing ? "relay" : tailscale ? "tailscale" : lan ? "lan" : "local",
    listenOverride: null,
    relayOverride: false,
    ...(relay.error ? { error: relay.error } : {}),
    networks: {
      lan: state(lan, "https://192.168.1.20:4243"),
      tailscale: state(tailscale, "https://100.64.0.1:4243"),
      relay,
      account: relay.state === "waiting" ? relay : { state: "off" },
    },
  };
}
