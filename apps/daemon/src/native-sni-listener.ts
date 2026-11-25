// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http";
import { nativeRemoteClass } from "@ace/provider-kit/native-transport";
import { closeListener, bindListener } from "./listener.ts";
import type { NativeUpgrade } from "./native-upgrade.ts";
import { startNativeRemote, type NativeRemoteListener } from "./native-remote.ts";
import { proxyGuard } from "./proxy-guard.ts";
import { sniLimits, type SniListener, type SniListenerOptions } from "./sni-listener.ts";
import type { TrustedCertificate } from "./tailscale-certificate.ts";

/**
 * The longest a timer may wait, in milliseconds: 2³¹−1. A certificate valid for longer than that
 * (90 days is usual) re-arms the sync instead of waiting for its expiry in one go.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** What a native run-time listener needs from the daemon it serves (T1b.4). */
export interface NativeSniListenerDeps {
  /** This boot's hop secret, the loopback's: the internal server admits nothing else. */
  secret: string;
  /**
   * Admission, release and registration for one listener's upgrades (`kind: "remote"`). Built per
   * listener, because each listener retires on its own and a late `101` must not outlive it.
   */
  upgrades(): NativeUpgrade;
  delay(callback: () => void, milliseconds: number): () => void;
  /** The clock the served certificate's expiry is measured on. */
  now(): number;
  /** Holds the public port as ace's from the bind to the close (ADR 0194). */
  tunnel: { hold(port: number): () => void };
}

/** A listener factory for `remoteDirect`: one `SniListener` per address it serves. */
export interface NativeSniListeners {
  make(options: SniListenerOptions): SniListener;
}

/** The native run-time listeners: Rust terminates TLS and HTTP, TypeScript decides each upgrade. */
export function nativeSniListeners(deps: NativeSniListenerDeps): NativeSniListeners {
  return { make: (options) => nativeSniListener(deps, options) };
}

/** The identity's PEM bytes exactly as `loadIdentity` read them; anything else is unusable. */
function pemBytes(value: unknown, part: string): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  throw new Error(`The native remote listener needs the identity's ${part} as PEM`);
}

function nativeSniListener(deps: NativeSniListenerDeps, options: SniListenerOptions): SniListener {
  const cert = pemBytes(options.tls.cert, "certificate");
  const key = pemBytes(options.tls.key, "key");
  // An identity Rust can't use throws here, where `createServer` throws on Node's listener today.
  nativeRemoteClass().checkIdentity(cert, key);
  const limits = sniLimits(options.limits);
  // The hop target, as `sniListener` builds one HTTP server per listener: it never listens
  // publicly, and every request arrives from Rust on loopback with this boot's secret.
  const internal = createServer(proxyGuard(deps.secret, options.requests));
  // The SNI listener's contract leaves the exchange unbounded (`ConnectionLimits::remote_sni`),
  // so the hop holds neither a request nor a header beside Rust's own `first_head` limit.
  internal.requestTimeout = 0;
  internal.headersTimeout = 0;
  const upgrades = deps.upgrades();
  let handle: NativeRemoteListener | undefined;
  let binding: Promise<number> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let certificate: TrustedCertificate | undefined;
  let unsubscribe: (() => void) | undefined;
  let cancelTimer: (() => void) | undefined;

  const stopWatching = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
  };
  /**
   * What Rust serves from now on: the certificate while TypeScript serves it, else the pinned
   * identity. A certificate TypeScript rejected leaves Rust on the pin, never on the old one.
   */
  const syncCertificate = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    const current = handle;
    if (current === undefined) return;
    const served = closed ? undefined : certificate?.served();
    if (served === undefined || certificate === undefined) {
      current.clearTrusted();
      return;
    }
    try {
      current.setTrusted(certificate.name, Buffer.from(served.cert), Buffer.from(served.key));
    } catch (failure) {
      options.log(failure instanceof Error ? failure : new Error(String(failure)));
      current.clearTrusted();
      return;
    }
    // The certificate leaves Rust at its expiry even if no fetch announces a new one.
    const until = Math.min(Math.max(0, served.expires - deps.now()), MAX_TIMER_MS);
    cancelTimer = deps.delay(syncCertificate, until);
  };

  return {
    http: internal,
    async listen(host, port) {
      // A retired listener never binds: its close already ran, and the internal server with it.
      if (closed) throw new Error("The listener was closed before its bind");
      const attempt = (async () => {
        try {
          const internalPort = await bindListener(internal, "127.0.0.1", 0);
          handle = await startNativeRemote({
            host,
            port,
            targetPort: internalPort,
            identity: { key, cert },
            hopSecret: deps.secret,
            // `ConnectionLimits::remote_sni`: the SNI listener's own timers (T1b.1a).
            limits: {
              handshakeMs: limits.handshake,
              firstHeadMs: limits.headers,
              headMs: null,
              keepAliveMs: limits.keepAlive,
              trustedKeepAliveMs: limits.trustedKeepAlive,
            },
            upgrade: upgrades,
            holdPort: (bound) => deps.tunnel.hold(bound),
            log: (error) => options.log(error),
          });
        } catch (failure) {
          // A listener that never bound has no Rust to close, but its internal server is open.
          await closeListener(internal);
          throw failure;
        }
        const bound = handle.port();
        // A certificate fetched before the bind reaches Rust now, not at its next renewal. A
        // close that ran before this bind landed still closes it: nothing stays listening.
        syncCertificate();
        if (closed) {
          await handle.close(0);
          handle = undefined;
        }
        return bound;
      })();
      binding = attempt;
      return attempt;
    },
    retire: () => {
      // `remoteDirect` marks the listener before it sweeps, so a `101` landing between the sweep
      // and `close` is closed as it registers (T1b.4).
      upgrades.retire?.();
    },
    trust: (next) => {
      // The previous certificate's subscription and timer go first: nothing it does reaches Rust.
      stopWatching();
      certificate = next;
      if (next !== undefined) unsubscribe = next.onServed(syncCertificate);
      // Usually called before the bind, which syncs then.
      if (handle !== undefined) syncCertificate();
    },
    close() {
      closed = true;
      stopWatching();
      closing ??= (async () => {
        // A bind still in flight lands first, so what it opened is closed here and not later.
        await binding?.catch(() => {});
        try {
          await handle?.close(0);
        } finally {
          handle = undefined;
          await closeListener(internal);
        }
      })();
      return closing;
    },
  };
}
