// SPDX-License-Identifier: Apache-2.0
import type { DeliveryRuntime } from "./delivery-runtime.ts";
import type { ReachFacts } from "./external-mcp/reach.ts";
import type { remoteDirect } from "./remote-direct.ts";
import type { RemotePlan } from "./remote-policy.ts";
import type { remoteRelays } from "./remote-relays.ts";
import { relayPairing, relayRoute } from "./relay-route.ts";
import { remoteNetworksStatus } from "./remote-status.ts";
import type { ServerOptions } from "./server-options.ts";

/** How long making a pairing link waits on a Tailscale certificate fetched again for it. */
const pairingCertificateWaitMs = 15_000;
/**
 * How long making a pairing link waits on remote access still starting: the direct listener, then,
 * with no direct address, the person's own relay. Past it the link names what serves by then.
 */
export const pairingStartWaitMs = 15_000;
/** Remote access as seen by pairing, status and outside MCP. */
export function remoteRuntimeView(wiring: {
  options: Pick<ServerOptions, "remoteConfig" | "relay" | "hostId">;
  direct: ReturnType<typeof remoteDirect>;
  relays: ReturnType<typeof remoteRelays>;
  delay: DeliveryRuntime["delay"];
  directStarted: Promise<void>;
  networksStarted: Promise<void>;
  pendingPlan(): RemotePlan | undefined;
  settingsError(): string | undefined;
}) {
  const {
    options,
    direct,
    relays,
    delay,
    directStarted,
    networksStarted,
    pendingPlan,
    settingsError,
  } = wiring;
  return {
    /**
     * Before a link is made: waits for remote access still starting (the direct listener, then,
     * with no direct address, the relays), at most `pairingStartWaitMs`, then fetches a failed
     * Tailscale certificate again (`refreshCertificate`).
     */
    beforePairing: async () => {
      const deadline = Promise.withResolvers<void>();
      const cancel = delay(() => deadline.resolve(), pairingStartWaitMs);
      try {
        await Promise.race([directStarted, deadline.promise]);
        if (!direct.open()) await Promise.race([networksStarted, deadline.promise]);
      } finally {
        cancel();
      }
      await direct.refreshCertificate(pairingCertificateWaitMs);
    },
    /** Settles once the direct listener's first start ended, or remote access closed. */
    directStarted: directStarted,
    /** Settles once every network's first start ended, or remote access closed. */
    started: networksStarted,
    /** Direct pairing links also carry the person's own relay when available (ADR 0182). */
    pairing: () => {
      const own = relays.selfHosted() && options.relay ? relayPairing(options.relay) : undefined;
      const address = direct.connection();
      if (address) return own ? { ...address, alsoRelay: own.relay } : address;
      return own;
    },
    status: () => {
      const config = options.remoteConfig;
      const pending = pendingPlan();
      const networks = remoteNetworksStatus({
        direct: {
          serving: direct.serving(),
          errors: direct.errors(),
          warnings: direct.warnings(),
          address: direct.address,
        },
        relays: relays.view(),
        ...(pending ? { pending } : {}),
      });
      const error = settingsError() ?? networks.error;
      return {
        ...networks,
        ...(error ? { error } : {}),
        listenOverride: config?.listenOverride ? config.listen : null,
        relayOverride: config?.relayUrl !== undefined,
        ...(options.relay ? relayRoute(options.relay, options.hostId) : {}),
      };
    },
    /** Where outside MCP clients can reach this machine beyond loopback (ADR 0122). */
    outsideReach: (): ReachFacts => ({
      tailscale: () =>
        direct.tailnet() ?? {
          problem:
            direct.errors().tailscale ??
            direct.warnings().tailscale ??
            (direct.serving().tailscale
              ? "Tailscale hasn't issued this machine's HTTPS certificate yet."
              : "Turn on Tailscale in Remote access."),
        },
      relay: () => {
        const hosted = relays.hosted();
        if (!hosted)
          return { problem: "Sign in to an ace account and turn on ace's relay in Remote access." };
        const url = new URL(hosted.url);
        const scheme = url.protocol === "ws:" ? "http:" : "https:";
        return { origin: `${scheme}//${url.host}`, hostId: hosted.hostId };
      },
    }),
  };
}
