import { createServer } from "node:https";
import type { RequestListener, Server } from "node:http";
import { SettingsError } from "@ace/settings";
import { remoteListener, systemNetwork, urlHost, type RemoteListener } from "./network.ts";
import { trustedCertificate, type TrustedCertificate } from "./tailscale-certificate.ts";
import { bindListener, closeListener } from "./listener.ts";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import type { ServerOptions } from "./server-options.ts";
import type { DirectPlan } from "./remote-policy.ts";
import { directAdvertisement, type DirectNetwork, type Resolved } from "./remote-direct-policy.ts";

export type DirectResolution = Partial<Record<DirectNetwork, Resolved>>;

/** Why a direct network can't start, in words the person can act on. */
function failureMessage(network: DirectNetwork): string {
  if (network === "tailscale") return "Start Tailscale on this computer, then try again.";
  return process.platform === "win32"
    ? "Couldn't find this computer's LAN address. Connect it to a network, or set ACE_ADVERTISE_HOST to its LAN address, then try again."
    : "Couldn't prepare encrypted LAN access. Check your network and OpenSSL installation, then try again.";
}

/**
 * The direct listener for LAN and Tailscale. Both run as one HTTPS listener: on the LAN it binds
 * every address (Tailscale's included), on Tailscale alone only the 100.x address. A network
 * that fails leaves the other serving; it never falls back to the LAN on its own.
 */
export function remoteDirect(deps: {
  options: ServerOptions;
  http: RequestListener;
  attach: (server: Server) => void;
  /** Drops the sockets of the listener being closed. */
  disconnect: () => void;
  /** Pairing links naming the old address or key stop working. */
  clearPending: () => void;
}) {
  const { options } = deps;
  let listener: Server | undefined;
  let bindHost: string | undefined;
  let port: number | undefined;
  let trusted: TrustedCertificate | undefined;
  let advertised: string | undefined;
  let fingerprint: string | undefined;
  let serving: DirectPlan = { lan: false, tailscale: false };
  let last: DirectResolution = {};
  let errors: Partial<Record<DirectNetwork, string>> = {};

  const resolveOne = async (network: DirectNetwork): Promise<RemoteListener | Error> => {
    const config = options.remoteConfig;
    if (!config) return new Error("Remote access is unavailable");
    try {
      const remote = await remoteListener({ ...config, listen: network }, options.network);
      return remote ?? new Error("Remote access is unavailable");
    } catch (failure) {
      return failure instanceof Error ? failure : new Error(String(failure));
    }
  };
  const stopTrusted = () => {
    trusted?.stop();
    trusted = undefined;
  };
  const takeDown = async (withdrawLinks: boolean) => {
    const open = listener;
    listener = undefined;
    if (open && withdrawLinks) deps.clearPending();
    if (open) deps.disconnect();
    stopTrusted();
    if (open) await closeListener(open);
    bindHost = undefined;
    port = undefined;
    advertised = undefined;
    fingerprint = undefined;
    serving = { lan: false, tailscale: false };
  };
  return {
    /**
     * Each wanted network's address, read before anything is taken down. A network that is
     * serving keeps its last address when a read fails: a check that fails never closes it.
     */
    async resolve(plan: DirectPlan): Promise<DirectResolution> {
      const resolution: DirectResolution = {};
      for (const network of ["lan", "tailscale"] as const) {
        if (!plan[network]) continue;
        const read = await resolveOne(network);
        const previous = last[network];
        resolution[network] =
          read instanceof Error && serving[network] && previous && !(previous instanceof Error)
            ? previous
            : read instanceof Error
              ? new SettingsError("io", failureMessage(network))
              : read;
      }
      return resolution;
    },
    /** Opens, moves, re-advertises or closes the listener to serve what `resolution` allows. */
    async commit(resolution: DirectResolution): Promise<void> {
      last = resolution;
      errors = {};
      for (const network of ["lan", "tailscale"] as const) {
        const read = resolution[network];
        if (read instanceof Error) errors[network] = read.message;
      }
      const target = directAdvertisement(resolution);
      if (!target) return takeDown(true);
      if (listener && bindHost !== target.host) await takeDown(true);
      const name = target.tailnetName;
      if (trusted?.name !== name) {
        stopTrusted();
        trusted = name
          ? trustedCertificate({
              name,
              fetch: (host) => (options.network ?? systemNetwork).certificate(host),
              now: options.now ?? options.runtime?.now ?? systemDeliveryRuntime.now,
              delay: options.runtime?.delay ?? systemDeliveryRuntime.delay,
              log: (failure) => options.log?.(failure),
            })
          : undefined;
      }
      if (!listener) {
        // Browsers asking for the ts.net name get Tailscale's trusted certificate; every other
        // client (and every client until it arrives) gets ace's own, pinned certificate.
        const server = createServer(
          {
            ...target.identity,
            minVersion: "TLSv1.2",
            SNICallback: (servername, done) => done(null, trusted?.select(servername)),
          },
          deps.http,
        );
        server.requestTimeout = 0;
        server.headersTimeout = 10_000;
        deps.attach(server);
        try {
          port = await bindListener(server, target.host, target.port);
        } catch (failure) {
          await closeListener(server);
          stopTrusted();
          throw failure;
        }
        listener = server;
        bindHost = target.host;
      }
      // Links name the address and key being replaced; a link for an address no longer
      // advertised is withdrawn.
      if (listener && advertised !== undefined && advertised !== target.advertisedHost)
        deps.clearPending();
      advertised = target.advertisedHost;
      fingerprint = target.identity.fingerprint;
      serving = target.serves;
    },
    /** What links name: the ts.net host only while browsers would trust it there. */
    connection(): { origin: string; fingerprint: string } | undefined {
      if (!listener || advertised === undefined || port === undefined || !fingerprint) return;
      const name = trusted?.active() ? trusted.name : undefined;
      return { origin: `https://${name ?? urlHost(advertised)}:${port}`, fingerprint };
    },
    /** Each network's address while it serves, for status. */
    address(network: DirectNetwork): string | undefined {
      const read = last[network];
      if (!serving[network] || !read || read instanceof Error || port === undefined) return;
      const name = network === "tailscale" && trusted?.active() ? trusted.name : undefined;
      return `https://${name ?? urlHost(read.advertisedHost)}:${port}`;
    },
    serving: () => serving,
    errors: () => errors,
    open: () => listener !== undefined,
    /** Closes the listener. Links stay valid: stopping the daemon replaces no address. */
    close: () => takeDown(false),
  };
}
