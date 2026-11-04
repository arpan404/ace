import type { RemoteAccessStatus, RemoteNetworkStatus } from "@ace/protocol";

const hostedRelay = "wss://relay.acehq.dev";

const state = (on: boolean, address: string): RemoteNetworkStatus =>
  on ? { state: "on", address } : { state: "off" };

/**
 * Remote access as the daemon reports it from its settings: every network turned on serves,
 * with no outages. While the machine is signed in to an ace account it is on ace's relay
 * whenever remote access is on (ADR 0112); signed out, ace's relay runs only when the relay is
 * turned on with no address, and then waits for a sign-in.
 */
export function fakeRemoteStatus(
  get: (key: string) => unknown,
  signedIn = false,
): RemoteAccessStatus {
  const enabled = get("remote.enabled") === true;
  const lan = enabled && get("remote.lan") === true;
  const tailscale = enabled && get("remote.tailscale") === true;
  const relayOn = enabled && get("remote.relay") === true;
  const own = typeof get("remote.relayUrl") === "string" ? String(get("remote.relayUrl")) : "";
  const relay: RemoteNetworkStatus = !relayOn
    ? { state: "off" }
    : own
      ? { state: "on", address: own }
      : signedIn
        ? { state: "on", address: hostedRelay }
        : {
            state: "waiting",
            error: "Sign in to your ace account on this machine to use ace's relay.",
            address: hostedRelay,
          };
  const account: RemoteNetworkStatus =
    enabled && signedIn
      ? { state: "on", address: hostedRelay }
      : relay.state === "waiting"
        ? relay
        : { state: "off" };
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
      account,
    },
  };
}
