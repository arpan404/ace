import type { RemoteAccessStatus, RemoteNetworkStatus } from "@ace/protocol";
import type { DirectPlan } from "./remote-policy.ts";
import type { DirectNetwork } from "./remote-direct-policy.ts";
import type { RelayView } from "./remote-relays.ts";

const off: RemoteNetworkStatus = { state: "off" };

function relayStatus(relay: RelayView | undefined): RemoteNetworkStatus {
  if (!relay) return off;
  return {
    state: relay.state,
    ...(relay.error ? { error: relay.error } : {}),
    address: relay.plan.url,
  };
}

/**
 * Remote access status from what each network is doing (ADR 0112): each network's state, plus
 * the single `transport`, `enabled` and `error` older clients read.
 */
export function remoteNetworksStatus(facts: {
  direct: {
    serving: DirectPlan;
    errors: Partial<Record<DirectNetwork, string>>;
    address: (network: DirectNetwork) => string | undefined;
  };
  relays: readonly RelayView[];
}): Pick<RemoteAccessStatus, "enabled" | "transport" | "error" | "networks"> {
  const { direct, relays } = facts;
  const directStatus = (network: DirectNetwork): RemoteNetworkStatus => {
    const error = direct.errors[network];
    if (error) return { state: "failed", error };
    const address = direct.address(network);
    return direct.serving[network] ? { state: "on", ...(address ? { address } : {}) } : off;
  };
  const chosen = relays.find((relay) => relay.plan.chosen);
  const hosted = relays.find((relay) => relay.plan.hosted);
  const networks = {
    lan: directStatus("lan"),
    tailscale: directStatus("tailscale"),
    relay: relayStatus(chosen),
    account: relayStatus(hosted),
  };
  const relayOn = relays.some((relay) => relay.state === "on");
  const transport =
    chosen?.state === "on"
      ? "relay"
      : direct.serving.tailscale
        ? "tailscale"
        : direct.serving.lan
          ? "lan"
          : relayOn
            ? "relay"
            : "local";
  const error =
    direct.errors.tailscale ??
    direct.errors.lan ??
    relays.find((relay) => relay.error && relay.plan.chosen)?.error ??
    relays.find((relay) => relay.error)?.error;
  return {
    enabled: direct.serving.lan || direct.serving.tailscale || relayOn,
    transport,
    ...(error ? { error } : {}),
    networks,
  };
}
