// SPDX-License-Identifier: Apache-2.0
import { noteTransportStart, transportAddon } from "@ace/provider-kit/native-transport";
import type { NativeUpgrade } from "./native-upgrade.ts";

/** How long a listener may take to decide an upgrade: `socket-admission.ts`'s hello window. */
const ADMIT_TIMEOUT_MS = 5_000;

/** The native loopback listener, started in the public port's place (ADR 0226, T1a.7). */
export interface StartedNativeLoopback {
  /** The public port Rust bound; a `0` request's port is known only here. */
  port: number;
  /** The internal `node:http` server the listener's hop forwards to. */
  internalHttpUrl: string;
  /** Stops the listener, waits for its sockets, and releases the port it held. */
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
  noteTransportStart(port);
  return {
    port,
    internalHttpUrl,
    async close(deadlineMs) {
      try {
        await native.close(deadlineMs);
      } finally {
        releasePort();
      }
    },
  };
}

/**
 * The startup unwind (T1a.7): native first, 1001 and a bounded terminate, then the listener drain,
 * and only then does the caller close the internal server. `releaseReservations` runs once the
 * listener stopped watching its admissions, so nothing it promised stays charged.
 */
export async function unwindNativeLoopback(
  native: StartedNativeLoopback | undefined,
  closeSockets: () => void,
  releaseReservations: () => void,
): Promise<void> {
  if (native === undefined) return;
  closeSockets();
  await native.close(0);
  releaseReservations();
}
