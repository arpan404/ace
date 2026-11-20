import { accessTicket } from "./access-ticket.ts";
import type { AccessOptions } from "./access-http.ts";
import { ephemeralRelayKeys } from "./device-route.ts";
import type { PortableSocket } from "./portable-relay.ts";
import {
  openMachineTunnel,
  tunnelChannel,
  type MachineTunnel,
  type TunnelPath,
} from "./machine-tunnel.ts";
export * from "./machine-tunnel.ts";

/*
 * The tunnel as an app opens it (ADR 0194): from the machine it belongs to, the path its machine
 * connection is on, and a dialer for the platform. Every path proves the same daemon, as the
 * main connection's do (ADR 0114): a direct path pins the TLS listener's public key and says
 * hello with a one-use ticket; a relay path pins the daemon's Noise key and carries the paired
 * token inside the encrypted stream; on both, the welcome must name the expected daemon.
 */

/** The machine the tunnel reaches, as its pairing knows it. */
export interface TunnelMachine {
  /** The daemon id every welcome must name: the paired machine's host id. */
  expectedHostId: string;
  /** This device's paired id. */
  deviceId: string;
  /**
   * The paired device's reusable token. It never goes on a direct socket: there it buys a
   * one-use ticket (`POST /v1/tickets`, under the pin) for each dial. Only a relay's encrypted
   * stream carries it.
   */
  token(): Promise<string>;
}

/** The path the machine connection is on, as the machine advertised it (`MachinePath`). */
export type TunnelPathTarget =
  | {
      kind: "direct";
      /** The path's identity (`PlannedPath.key`): a different key is a path switch. */
      key: string;
      /** The daemon's TLS listener socket address, `wss://host:port/`. */
      url: string;
      /** SHA-256 of the listener certificate's public key (SPKI DER), lowercase hex. */
      fingerprint: string;
    }
  | {
      kind: "relay";
      key: string;
      /** The relay's WebSocket address. */
      url: string;
      /** The daemon's relay host key fingerprint, which the Noise handshake pins. */
      hostKey: string;
    };

/** The platform's sockets: pinned TLS for direct paths, a plain socket for relays. */
export interface TunnelDialer {
  /**
   * A WebSocket to a daemon's TLS listener that fails before sending a byte unless the
   * certificate's public key hashes to `fingerprint` (or, on a ts.net name, Tailscale's
   * publicly trusted certificate for that exact name: ADR 0097).
   */
  direct(url: string, fingerprint: string): PortableSocket;
  /** HTTPS to the same listener under the same pin, for the ticket exchange. */
  directFetch(fingerprint: string): AccessOptions["fetch"];
  /** A WebSocket to a relay; the daemon behind it is proved by the Noise pin, not this TLS. */
  relay(url: string, protocols?: string[]): PortableSocket;
}

export interface PathTunnelOptions {
  machine: TunnelMachine;
  /** The machine connection's path now; undefined while it is offline. */
  path: { get(): TunnelPathTarget | undefined; subscribe(changed: () => void): () => void };
  dialer: TunnelDialer;
  /** Runs `run` after `delayMs`; the result cancels it. */
  schedule(run: () => void, delayMs: number): () => void;
  /** How long an old path's streams may take to finish after a switch; 15 s unless given. */
  drainMs?: number;
  /** Where the engine lacks a global `ReadableStream` (a bare JavaScriptCore), supply one. */
  ReadableStream?: typeof ReadableStream;
}

/** The ticket origin of a direct path's socket address. */
function ticketOrigin(url: string): string {
  const origin = new URL(url);
  if (origin.protocol !== "wss:") throw new Error("A direct tunnel path needs a wss:// address");
  origin.protocol = "https:";
  return `${origin.origin}/`;
}

/** One tunnel path, dialed with every check its kind needs. */
export function tunnelPath(
  target: TunnelPathTarget,
  machine: TunnelMachine,
  dialer: TunnelDialer,
  schedule: PathTunnelOptions["schedule"],
): TunnelPath {
  const common = {
    deviceId: machine.deviceId,
    expectedHostId: machine.expectedHostId,
    keys: ephemeralRelayKeys,
    schedule,
  };
  if (target.kind === "direct") {
    if (!/^[0-9a-f]{64}$/.test(target.fingerprint))
      throw new Error("A direct tunnel path needs the listener's public-key fingerprint");
    const origin = ticketOrigin(target.url);
    return {
      key: target.key,
      link: () =>
        tunnelChannel({
          ...common,
          target: { kind: "local", url: target.url },
          credential: async () => {
            const { ticket } = await accessTicket({
              origin,
              token: machine.token,
              fetch: dialer.directFetch(target.fingerprint),
            });
            return { ticket };
          },
          socket: (url) => dialer.direct(url, target.fingerprint),
        }),
    };
  }
  return {
    key: target.key,
    link: () =>
      tunnelChannel({
        ...common,
        target: { kind: "relay", url: target.url, pinnedFingerprint: target.hostKey },
        credential: machine.token,
        socket: (url, protocols) => dialer.relay(url, protocols),
      }),
  };
}

/**
 * Opens the tunnel to one connected machine on the paths its connection uses. The desktop app's
 * main process and the phone's bridge both open it this way, with their platform's dialer.
 */
export function openPathTunnel(options: PathTunnelOptions): MachineTunnel {
  let built: { target: TunnelPathTarget; path: TunnelPath } | undefined;
  const current = (): TunnelPath | undefined => {
    const target = options.path.get();
    if (!target) return undefined;
    if (built?.target !== target)
      built = {
        target,
        path: tunnelPath(target, options.machine, options.dialer, options.schedule),
      };
    return built.path;
  };
  return openMachineTunnel({
    path: { get: current, subscribe: options.path.subscribe },
    schedule: options.schedule,
    ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }),
    ...(options.ReadableStream ? { ReadableStream: options.ReadableStream } : {}),
  });
}
