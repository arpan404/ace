// SPDX-License-Identifier: Apache-2.0
import {
  nativeRemoteClass,
  noteTransportEvent,
  noteTransportStart,
  registerTransportListener,
  transportFailureCode,
  type NativeHandled,
  type NativeRemoteHandle,
  type NativeRemoteLimits,
} from "@ace/provider-kit/native-transport";
import { ownReservations, type NativeUpgrade } from "./native-upgrade.ts";

/** How long admission may take when the caller names none: the hello window. */
const ADMIT_TIMEOUT_MS = 5_000;

/** What a native remote listener needs from the daemon it opens sockets into. */
export interface NativeRemoteOptions {
  /** The bind address: a LAN address, Tailscale's 100.x, or 127.0.0.1 in a test. */
  host: string;
  /** The public port; `0` picks a free one. */
  port: number;
  /** The internal `node:http` server the hop forwards to. */
  targetPort: number;
  /** The identity exactly as `loadIdentity` read it: PEM bytes, never regenerated. */
  identity: { key: Buffer; cert: Buffer };
  /** This boot's hop secret, the loopback listener's: kept in memory and passed back. */
  hopSecret: string;
  limits: NativeRemoteLimits;
  /** Admission, release and registration for this listener (`kind: "remote"`). */
  upgrade: NativeUpgrade;
  /** Holds the public port as ace's (ADR 0194); the returned function releases it. */
  holdPort(port: number): () => void;
  /** Where a post-bind accept failure is logged, as `sni-listener.ts:187` logs its own. */
  log(error: Error): void;
}

/** A running native remote listener: its port, its certificate, and its close. */
export interface NativeRemoteListener {
  port(): number;
  /** Serves `name` the trusted certificate from the next handshake on. */
  setTrusted(name: string, cert: Buffer, key: Buffer): void;
  /** Serves the pinned certificate again from the next handshake on. */
  clearTrusted(): void;
  close(deadlineMs: number): Promise<void>;
}

/**
 * Starts one native remote listener (T1b.1b): Rust terminates TLS and HTTP, TypeScript decides
 * every upgrade through the same admission and registration as the `ws` listeners. With
 * `ACE_TRANSPORT_EVIDENCE` set, each lifecycle step Rust reports is one line, and the close line
 * carries what the listener, on that port, handled.
 *
 * The reservations admitted through this listener are held here and released when `close`
 * resolves: only this listener's, never the loopback's or another remote listener's.
 */
export async function startNativeRemote(
  options: NativeRemoteOptions,
): Promise<NativeRemoteListener> {
  // This listener's own reservations: its close releases what it admitted, and nothing else.
  const upgrade = ownReservations(options.upgrade);
  let handle: NativeRemoteHandle;
  try {
    handle = await nativeRemoteClass().start(
      {
        host: options.host,
        port: options.port,
        targetPort: options.targetPort,
        secretHex: options.hopSecret,
        admitTimeoutMs: ADMIT_TIMEOUT_MS,
        cert: options.identity.cert,
        key: options.identity.key,
        // napi reads `None` from an absent field, never from `null`.
        limits: {
          ...options.limits,
          headMs: options.limits.headMs ?? undefined,
          trustedKeepAliveMs: options.limits.trustedKeepAliveMs ?? undefined,
        },
      },
      upgrade.admit,
      upgrade.release,
      upgrade.opened,
      (code, message, repeated) => {
        const failure = new Error(message);
        Object.assign(failure, { code, repeated });
        options.log(failure);
      },
    );
  } catch (error) {
    // The bind never landed: the requested port is the only port to name. `code` is the OS's
    // (`EADDRINUSE`, `EADDRNOTAVAIL`), as `bindListener`'s failure carries it.
    noteTransportEvent("remote", options.port, "bind-failed", {
      code: transportFailureCode(error),
    });
    throw error;
  }
  const port = handle.port();
  const releasePort = options.holdPort(port);
  const instance = noteTransportStart("remote", port);
  const unregister = registerTransportListener("remote", port, instance, () => handle.handled());
  let closing: Promise<void> | undefined;
  return {
    port: () => port,
    setTrusted: (name, cert, key) => handle.setTrusted(name, cert, key),
    clearTrusted: () => handle.clearTrusted(),
    close(deadlineMs) {
      closing ??= (async () => {
        noteTransportEvent("remote", port, "close-requested", { bound: true, instance });
        let closed = false;
        try {
          await handle.close(deadlineMs);
          closed = true;
        } finally {
          unregister();
          releasePort();
          // Only this listener's reservations; the loopback's are the loopback's.
          upgrade.releaseHeld();
        }
        if (closed) {
          const counts: NativeHandled = handle.handled();
          // What this listener, on this port, handled: a bind line only proves a bind.
          noteTransportEvent("remote", port, "close", { ...counts, instance });
        }
      })();
      return closing;
    },
  };
}
