import type { Config } from "./config.ts";
import type { SettingsValues } from "@ace/protocol";
import { HostedAddress } from "@ace/protocol/ace-account";
import { isHostedRelay } from "./relay-account.ts";

export type RemotePreferences = Pick<
  SettingsValues,
  "remote.enabled" | "remote.lan" | "remote.tailscale" | "remote.relay" | "remote.relayUrl"
>;
export const remotePreferenceKeys = [
  "remote.enabled",
  "remote.lan",
  "remote.tailscale",
  "remote.relay",
  "remote.relayUrl",
] as const;

/** The direct listener: the networks it serves. Both run as one listener on every address. */
export interface DirectPlan {
  lan: boolean;
  tailscale: boolean;
}

/**
 * One relay this machine registers on. `hosted` is ace's relay, which needs this machine's ace
 * account (`accountId`, undefined while signed out); `chosen` is the relay the person turned on.
 */
export interface RelayPlan {
  url: string;
  hosted: boolean;
  chosen: boolean;
  accountId?: string;
  /** Equal keys are the same registration; a different key replaces it. */
  key: string;
}

export interface RemotePlan {
  direct: DirectPlan;
  /** At most one per relay origin, so this machine never registers twice on the same relay. */
  relays: RelayPlan[];
}

/**
 * Which networks run (ADR 0112). Launch overrides pin the direct listener (`ACE_LISTEN`) and add
 * a relay (`ACE_RELAY_URL`). Otherwise, while remote access is on: the LAN and Tailscale as
 * chosen; the person's relay (their address, or ace's relay when they named none); and ace's
 * relay whenever this machine is signed in to an ace account.
 */
export function remotePlan(
  config: Pick<Config, "listen" | "listenOverride" | "relayUrl" | "hostedRelayUrl">,
  preferences: RemotePreferences,
  accountId: string | undefined,
): RemotePlan {
  const enabled = preferences["remote.enabled"];
  const listenOverride = config.listenOverride ?? config.listen !== "local";
  const direct = listenOverride
    ? { lan: config.listen === "lan", tailscale: config.listen === "tailscale" }
    : {
        lan: enabled && preferences["remote.lan"],
        tailscale: enabled && preferences["remote.tailscale"],
      };
  const hostedUrl = config.hostedRelayUrl;
  const chosenUrl =
    config.relayUrl ??
    (enabled && preferences["remote.relay"] ? preferences["remote.relayUrl"] || hostedUrl : "");
  const relays: RelayPlan[] = [];
  const chosenIsHosted = chosenUrl ? isHostedRelay(chosenUrl, hostedUrl) : false;
  if (chosenUrl && !chosenIsHosted)
    relays.push({ url: chosenUrl, hosted: false, chosen: true, key: chosenUrl });
  const hosted = chosenIsHosted || (enabled && accountId !== undefined);
  // A relay setting saved on a former address of ace's backend runs at the current address.
  const url = chosenIsHosted ? HostedAddress.parse(chosenUrl) : hostedUrl;
  if (hosted && url)
    relays.push({
      url,
      hosted: true,
      chosen: chosenIsHosted,
      ...(accountId === undefined ? {} : { accountId }),
      key: JSON.stringify([url, accountId ?? null]),
    });
  return { direct, relays };
}

/** The direct networks `next` turns on that `before` didn't run. */
export function addedDirect(before: DirectPlan, next: DirectPlan): DirectPlan {
  return { lan: next.lan && !before.lan, tailscale: next.tailscale && !before.tailscale };
}
