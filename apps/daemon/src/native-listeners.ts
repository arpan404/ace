// SPDX-License-Identifier: Apache-2.0
import { createServer, type RequestListener, type Server } from "node:http";
import type { WebSocketServer } from "ws";
import {
  noteTransportEvent,
  noteTransportStart,
  registerTransportListener,
  transportAddon,
  type NativeRemoteLimits,
} from "@ace/provider-kit/native-transport";
import { bindListener as bind, closeListener } from "./listener.ts";
import type { MainSocket } from "./main-socket.ts";
import { startNativeRemote, type NativeRemoteListener } from "./native-remote.ts";
import { nativeUpgrade, type NativeUpgrade, type NativeUpgradeWiring } from "./native-upgrade.ts";
import { urlHost } from "./network.ts";
import { proxyGuard } from "./proxy-guard.ts";

/** How long a listener may take to decide an upgrade: `socket-admission.ts`'s hello window. */
const ADMIT_TIMEOUT_MS = 5_000;

/** `ConnectionLimits::remote_static()`: a `node:https` server's own defaults (T1b.1a). */
const STATIC_LIMITS: NativeRemoteLimits = {
  handshakeMs: 120_000,
  firstHeadMs: 10_000,
  headMs: 10_000,
  keepAliveMs: 5_000,
  trustedKeepAliveMs: null,
};

/** The native loopback listener, started in the public port's place (ADR 0226, T1a.7). */
export interface StartedNativeLoopback {
  /** The public port Rust bound; a `0` request's port is known only here. */
  port: number;
  /** The internal `node:http` server the listener's hop forwards to. */
  internalHttpUrl: string;
  /** Stops the listener, waits for its sockets, and releases the port it held. */
  close(deadlineMs: number): Promise<void>;
}

/** The static remote listener, in the place of the `node:https` server `server.ts` builds. */
export interface StartedNativeRemote {
  /** The public port Rust bound. */
  port: number;
  /** Stops the listener, then its internal server. */
  close(deadlineMs: number): Promise<void>;
}

export interface NativeLoopbackStart {
  /** The public port; `0` picks a free one. */
  port: number;
  /** Binds the internal `node:http` server and settles with its port. */
  bindInternal(): Promise<number>;
  /** This boot's hop secret, hex: kept in memory and passed back to the listener. */
  hopSecret: string;
  /** Admission, release and registration, the same the `ws` listeners use. */
  upgrades: NativeUpgrade;
  /** Holds a port as ace's (ADR 0194); the returned function releases it. */
  holdPort(port: number): () => void;
}

/**
 * The native loopback's start (T1a.7): the internal server first, then the public listener in its
 * place, both ports ace's from the bind. The listener forwards HTTP to the internal server and asks
 * TypeScript to admit every upgrade.
 */
export async function startNativeLoopback(
  options: NativeLoopbackStart,
): Promise<StartedNativeLoopback> {
  const internalPort = await options.bindInternal();
  const internalHttpUrl = `http://127.0.0.1:${internalPort}`;
  const native = await transportAddon().NativeLoopback.start(
    {
      port: options.port,
      targetPort: internalPort,
      secretHex: options.hopSecret,
      admitTimeoutMs: ADMIT_TIMEOUT_MS,
    },
    options.upgrades.admit,
    options.upgrades.release,
    options.upgrades.opened,
  );
  const port = native.port();
  // Both ports are ace's from the bind (ADR 0194): the internal one through `attach`'s
  // `tunnel.track`, the public one here.
  const releasePort = options.holdPort(port);
  noteTransportStart("loopback", port);
  const unregister = registerTransportListener("loopback", port, () => native.handled());
  return {
    port,
    internalHttpUrl,
    async close(deadlineMs) {
      noteTransportEvent("loopback", port, "close-requested", { bound: true });
      try {
        await native.close(deadlineMs);
      } finally {
        noteTransportEvent("loopback", port, "close", native.handled());
        unregister();
        releasePort();
      }
    },
  };
}

/** What the static remote listener needs: its identity, its hop target, and the tunnel. */
export interface NativeStaticRemoteStart {
  host: string;
  /** The public port; `0` picks a free one. */
  port: number;
  identity: { key: Buffer; cert: Buffer };
  /** The loopback listener's per-boot hop secret. */
  hopSecret: string;
  /** The paired-device HTTP chain the hop forwards to. */
  requests: RequestListener;
  /** Admission's wiring, minus this listener's own kind, `wss` and socket set. */
  admission: Omit<NativeUpgradeWiring, "kind" | "wss" | "sockets">;
  /** The socket server this listener's `connection` event reaches: `remoteWss`. */
  wss: WebSocketServer;
  /** The sockets the listener opens: `remoteSockets`, swept with the `ws` ones. */
  sockets: Set<MainSocket>;
  holdPort(port: number): () => void;
  track(server: Server): void;
  log(error: Error): void;
}

/**
 * The static remote listener (T1b.1b): the internal server first, then Rust in the place of the
 * `node:https` server. The internal server never listens publicly; an upgrade sent straight to it
 * is destroyed, as T1a.7's local internal server does.
 */
export async function startNativeStaticRemote(
  options: NativeStaticRemoteStart,
): Promise<StartedNativeRemote> {
  const internal = createServer(proxyGuard(options.hopSecret, options.requests));
  internal.requestTimeout = 0;
  internal.headersTimeout = 10_000;
  internal.on("upgrade", (_request, socket) => socket.destroy());
  options.track(internal);
  const internalPort = await bind(internal, "127.0.0.1", 0);
  let listener: NativeRemoteListener;
  try {
    listener = await startNativeRemote({
      host: options.host,
      port: options.port,
      targetPort: internalPort,
      identity: options.identity,
      hopSecret: options.hopSecret,
      limits: STATIC_LIMITS,
      upgrade: nativeUpgrade({
        ...options.admission,
        kind: "remote",
        wss: options.wss,
        sockets: options.sockets,
      }),
      holdPort: options.holdPort,
      log: options.log,
    });
  } catch (error) {
    await closeListener(internal);
    throw error;
  }
  return {
    port: listener.port(),
    async close(deadlineMs) {
      try {
        await listener.close(deadlineMs);
      } finally {
        await closeListener(internal);
      }
    },
  };
}

/** The two native listeners as one shutdown: the loopback's close releases its reservations. */
export interface NativeListeners {
  loopback?: StartedNativeLoopback | undefined;
  remote?: StartedNativeRemote | undefined;
}

/** What the start needs for the remote listener: either backend, one contract. */
export interface NativeRemoteStart {
  /** Whether Rust serves TLS; false binds the `node:https` server through `bind`. */
  native: boolean;
  host: string;
  port: number;
  advertisedHost: string;
  identity: { key: Buffer; cert: Buffer };
  requests: RequestListener;
  /** Admission's wiring, minus the listener's own kind, `wss` and socket set. */
  admission: Omit<NativeUpgradeWiring, "kind" | "wss" | "sockets">;
  /** The socket server this listener's `connection` event reaches: `remoteWss`. */
  wss: WebSocketServer;
  /** Binds the TypeScript `https` listener; absent when `native`. */
  bind?: (() => Promise<number>) | undefined;
  log(error: Error): void;
}

/** Everything the two listeners need from the server's own wiring. */
export interface NativeListenersStart {
  /** The public port; `0` picks a free one. */
  port: number;
  /** Present exactly when the loopback part is native. */
  hopSecret: string | undefined;
  /** Binds the local server: the internal one when native, else the public one. */
  bindLocal(port: number): Promise<number>;
  loopbackUpgrades: NativeUpgrade;
  /** Records the public port before any upgrade can be admitted. */
  publicPort(port: number): void;
  /** The machine tunnel: ports held, servers tracked, as ace's (ADR 0194). */
  tunnel: { hold(port: number): () => void; track(server: Server): void };
  /** The remote listener's sockets, `remoteSockets`. */
  sockets: Set<MainSocket>;
  remote?: NativeRemoteStart | undefined;
}

/** The listeners a start produced, plus where clients reach them. */
export interface StartedNativeListeners extends NativeListeners {
  port: number;
  internalHttpUrl?: string | undefined;
  remoteOrigin?: string | undefined;
}

/**
 * Starts the listeners in `server.ts`'s order: the loopback first (internal server, then Rust or
 * the `node:http` listener in the public port's place), then the remote listener, native or
 * TypeScript. Nothing here decides whether the switch is on; the caller's wiring says that.
 */
export async function startNativeListeners(
  options: NativeListenersStart,
): Promise<StartedNativeListeners> {
  let port: number;
  let internalHttpUrl: string | undefined;
  let loopback: StartedNativeLoopback | undefined;
  if (options.hopSecret === undefined) {
    port = await options.bindLocal(options.port);
  } else {
    // Known before Rust accepts; a `0` port is refused until recorded below (T1a.7).
    options.publicPort(options.port);
    loopback = await startNativeLoopback({
      port: options.port,
      bindInternal: () => options.bindLocal(0),
      hopSecret: options.hopSecret,
      upgrades: options.loopbackUpgrades,
      holdPort: (bound) => options.tunnel.hold(bound),
    });
    port = loopback.port;
    internalHttpUrl = loopback.internalHttpUrl;
    options.publicPort(port);
  }
  let remote: StartedNativeRemote | undefined;
  let remoteOrigin: string | undefined;
  const remoteConfig = options.remote;
  if (remoteConfig) {
    let remotePort: number;
    if (remoteConfig.native) {
      if (options.hopSecret === undefined)
        throw new Error("ACE_TRANSPORT=native,remote needs the loopback listener's hop secret");
      remote = await startNativeStaticRemote({
        host: remoteConfig.host,
        port: remoteConfig.port,
        identity: remoteConfig.identity,
        hopSecret: options.hopSecret,
        requests: remoteConfig.requests,
        admission: remoteConfig.admission,
        wss: remoteConfig.wss,
        sockets: options.sockets,
        holdPort: (bound) => options.tunnel.hold(bound),
        track: (server) => options.tunnel.track(server),
        log: remoteConfig.log,
      });
      remotePort = remote.port;
    } else if (remoteConfig.bind !== undefined) {
      remotePort = await remoteConfig.bind();
    } else {
      throw new Error("The remote listener has no bind");
    }
    remoteOrigin = `https://${urlHost(remoteConfig.advertisedHost)}:${remotePort}`;
  }
  return {
    port,
    ...(internalHttpUrl === undefined ? {} : { internalHttpUrl }),
    ...(remoteOrigin === undefined ? {} : { remoteOrigin }),
    ...(loopback === undefined ? {} : { loopback }),
    ...(remote === undefined ? {} : { remote }),
  };
}

/**
 * The native listeners' closes, made once: the loopback's, which releases the reservations it
 * promised once it stopped, and the static remote's, which closes its internal server after it.
 */
export function shutdownNativeListeners(
  listeners: NativeListeners,
  deadlineMs: number,
  releaseReservations: () => void,
): { loopback: Promise<void> | undefined; remote: Promise<void> | undefined } {
  const loopback = listeners.loopback?.close(deadlineMs).finally(releaseReservations);
  return { loopback, remote: listeners.remote?.close(deadlineMs) };
}

/**
 * The shutdown stages the native listeners own, in `server.ts`'s order: the loopback, then the
 * local server after it, then the remote listener (native's close or the TypeScript one's).
 */
export function nativeListenerStages(
  closing: { loopback: Promise<void> | undefined; remote: Promise<void> | undefined },
  closeLocal: () => Promise<void>,
  closeTsRemote: (() => Promise<void>) | undefined,
): [name: string, task: Promise<unknown> | undefined][] {
  const local =
    closing.loopback === undefined ? closeLocal() : closing.loopback.finally(closeLocal);
  return [
    ["native listener", closing.loopback],
    ["local listener", local],
    ...(closing.remote !== undefined
      ? [["remote listener", closing.remote] as [string, Promise<unknown>]]
      : closeTsRemote === undefined
        ? []
        : [["remote listener", closeTsRemote()] as [string, Promise<unknown>]]),
  ];
}

/** Gives every socket a native listener opened the shutdown close, with the other sockets. */
export function closeNativeSockets(
  sockets: readonly ReadonlySet<MainSocket>[],
  close: (socket: MainSocket) => void,
): void {
  for (const set of sockets) for (const socket of set) close(socket);
}

/**
 * The startup unwind (T1a.7, T1b.1b): 1001 and a bounded terminate for the sockets these listeners
 * opened, then the listeners, then, in the caller, the internal server. `releaseReservations` runs
 * once the loopback listener stopped watching its admissions, so nothing it promised stays charged.
 */
export async function unwindNativeListeners(
  listeners: NativeListeners,
  sockets: readonly ReadonlySet<MainSocket>[],
  closeSocket: (socket: MainSocket) => void,
  releaseReservations: () => void,
): Promise<void> {
  if (listeners.loopback === undefined && listeners.remote === undefined) return;
  for (const set of sockets) for (const socket of set) closeSocket(socket);
  await listeners.loopback?.close(0);
  // The static remote listener's internal server closes with it.
  await listeners.remote?.close(0);
  releaseReservations();
}
