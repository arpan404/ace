// SPDX-License-Identifier: Apache-2.0
import type { WebSocketServer } from "ws";
import type {
  NativeSocketHandle,
  TransportAdmitAnswer,
  TransportAdmitRequest,
} from "@ace/provider-kit/native-transport";
import type { MainSocket } from "./main-socket.ts";
import { NativeSocket } from "./native-socket.ts";
import type { PreAuthAdmission } from "./socket-admission.ts";
import { ownLoopbackOrigin, upgradeDecision } from "./socket-upgrade.ts";

/** What the native listener's upgrade half needs from the daemon it opens sockets into. */
export interface NativeUpgradeWiring {
  /** The local socket server whose `connection` listeners register a main socket. */
  wss: WebSocketServer;
  preAuth: PreAuthAdmission;
  allowedOrigins: ReadonlySet<string>;
  /** Whether the daemon serves the web app, whose page may open its own loopback origin. */
  servesRenderer: boolean;
  /** The public listener's port: the own-Origin check compares against it, not the internal one. */
  publicPort(): number;
  /** The daemon has begun shutting down: no upgrade may take a reservation any more. */
  draining(): boolean;
  /** The one capacity check shared with `ws` upgrades, reservations included. */
  full(): boolean;
  /** Sockets the native listener opened: no `ws` server owns them, so owners sweep them. */
  sockets: Set<MainSocket>;
}

/** Admission, release and registration for the native loopback listener (ADR 0226, T1a.7). */
export interface NativeUpgrade {
  /** Today's decision over this snapshot; an acceptance takes its capacity reservation at once. */
  admit(request: TransportAdmitRequest): Promise<TransportAdmitAnswer>;
  /** Drops a reservation that never became a socket; the Rust state machine owns every call. */
  release(reservation: number): void;
  /** A socket whose `101` is on the wire: register it as the main socket it is. */
  opened(
    handle: NativeSocketHandle,
    reservation: number,
    userAgent: string | null | undefined,
  ): void;
}

/**
 * The native listener asks TypeScript; this module answers and registers. It decides nothing
 * itself: `upgradeDecision` is the same function the `ws` listeners use, `preAuth` the same
 * budget, and `wss`'s `connection` event the same registration path, so a native socket reaches
 * the daemon exactly where a `ws` one does.
 */
export function nativeUpgrade(wiring: NativeUpgradeWiring): NativeUpgrade {
  const admit = async (request: TransportAdmitRequest): Promise<TransportAdmitAnswer> => {
    // A queued admission can run after shutdown's sweep. It must take no hold, and a closing
    // listener answers `ws`'s closing-state 503, not admission's empty-body one.
    if (wiring.draining()) return { decision: "closing", reservation: 0 };
    // The listener binds before JavaScript records its port; until then an
    // own-Origin check would compare against 0 and refuse a page that is ours.
    // Refuse the upgrade instead, and the client retries once the port is known.
    const port = wiring.publicPort();
    if (port === 0) return { decision: "unavailable", reservation: 0 };
    const decision = upgradeDecision({
      url: request.target,
      origin: request.origin ?? undefined,
      isLocal: true,
      address: request.address,
      servesRenderer: wiring.servesRenderer,
      // The public (native) port, not the internal server's: the page reaches that one.
      ownOrigin: (origin) => ownLoopbackOrigin(origin, port),
      allowedOrigins: wiring.allowedOrigins,
      full: wiring.full,
      preAuth: wiring.preAuth,
    });
    if (decision !== "accept") return { decision, reservation: 0 };
    return { decision, reservation: wiring.preAuth.reserve("local", request.address) };
  };
  const release = (reservation: number) => wiring.preAuth.release(reservation);
  const opened = (
    handle: NativeSocketHandle,
    reservation: number,
    userAgent: string | null | undefined,
  ) => {
    const socket = new NativeSocket(handle);
    wiring.sockets.add(socket);
    socket.once("close", () => wiring.sockets.delete(socket));
    wiring.wss.emit(
      "connection",
      socket,
      true,
      { headers: { "user-agent": userAgent ?? undefined } },
      undefined,
      reservation,
    );
  };
  return { admit, release, opened };
}
