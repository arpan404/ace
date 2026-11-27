// SPDX-License-Identifier: Apache-2.0
import type { WebSocketServer } from "ws";
import { APP_SOCKET_HEADER } from "@ace/protocol";
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
  /**
   * Which listener this is: `isLocal` for `upgradeDecision`, and the kind of reservation both
   * the pre-auth budget and the socket sweep use (data, not a mode flag).
   */
  kind: "local" | "remote";
  /** The socket server whose `connection` listeners register a main socket. */
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
  /**
   * Ends a socket that registered after its listener's retire sweep: the daemon's shutdown close
   * (1001 and a bounded terminate), so Rust's own close is not held open by it (T1b.4).
   */
  closeSocket?(socket: MainSocket): void;
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
    appSocketTag?: string,
  ): void;
  /**
   * The listener is retiring: its sweep runs next, so a `101` that finishes afterwards would
   * register into the set nobody sweeps again. Such a socket is closed as it registers
   * (`closeSocket`), because Rust waits for it before its close returns (T1b.4).
   */
  retire?(): void;
}

/** One listener's view of the reservations it admitted: nobody else's are released at its close. */
export interface OwnedUpgrade extends NativeUpgrade {
  /** Releases every reservation this listener still holds, and only those. */
  releaseHeld(): void;
}

/**
 * The reservations one listener admitted, kept apart from every other listener's. TypeScript takes a
 * pre-auth slot at `admit` and gives it up at `release` or `opened`; whatever is still held when the
 * listener closes is released here, so a closing loopback never drops a remote upgrade's charge.
 */
export function ownReservations(upgrade: NativeUpgrade): OwnedUpgrade {
  // Keep the upgrade header with its reservation until registration or release.
  const held = new Map<number, string | undefined>();
  return {
    async admit(request) {
      const answer = await upgrade.admit(request);
      if (answer.decision === "accept") {
        held.set(answer.reservation, request.appSocketTag ?? undefined);
      }
      return answer;
    },
    release(reservation) {
      held.delete(reservation);
      upgrade.release(reservation);
    },
    opened(handle, reservation, userAgent) {
      // The registration consumes the reservation, exactly as a `ws` upgrade's does.
      const appSocketTag = held.get(reservation);
      held.delete(reservation);
      upgrade.opened(handle, reservation, userAgent, appSocketTag);
    },
    retire() {
      upgrade.retire?.();
    },
    releaseHeld() {
      for (const reservation of held.keys()) upgrade.release(reservation);
      held.clear();
    },
  };
}

/**
 * The native listener asks TypeScript; this module answers and registers. It decides nothing
 * itself: `upgradeDecision` is the same function the `ws` listeners use, `preAuth` the same
 * budget, and `wss`'s `connection` event the same registration path, so a native socket reaches
 * the daemon exactly where a `ws` one does.
 */
export function nativeUpgrade(wiring: NativeUpgradeWiring): NativeUpgrade {
  const isLocal = wiring.kind === "local";
  const kind = wiring.kind;
  let retired = false;
  const admit = async (request: TransportAdmitRequest): Promise<TransportAdmitAnswer> => {
    // A queued admission can run after shutdown's sweep. It must take no hold, and a closing
    // listener answers `ws`'s closing-state 503, not admission's empty-body one.
    if (wiring.draining()) return { decision: "closing", reservation: 0 };
    // The listener binds before JavaScript records its port; until then an
    // own-Origin check would compare against 0 and refuse a page that is ours.
    // Refuse the upgrade instead, and the client retries once the port is known.
    const port = wiring.publicPort();
    if (isLocal && port === 0) return { decision: "unavailable", reservation: 0 };
    const decision = upgradeDecision({
      url: request.target,
      origin: request.origin ?? undefined,
      isLocal,
      address: request.address,
      servesRenderer: wiring.servesRenderer,
      // The public (native) port, not the internal server's: the page reaches that one.
      ownOrigin: (origin) => ownLoopbackOrigin(origin, port),
      allowedOrigins: wiring.allowedOrigins,
      full: wiring.full,
      preAuth: wiring.preAuth,
    });
    if (decision !== "accept") return { decision, reservation: 0 };
    return { decision, reservation: wiring.preAuth.reserve(kind, request.address) };
  };
  const release = (reservation: number) => wiring.preAuth.release(reservation);
  const opened = (
    handle: NativeSocketHandle,
    reservation: number,
    userAgent: string | null | undefined,
    appSocketTag?: string,
  ) => {
    const socket = new NativeSocket(handle);
    wiring.sockets.add(socket);
    socket.once("close", () => wiring.sockets.delete(socket));
    wiring.wss.emit(
      "connection",
      socket,
      isLocal,
      { headers: { "user-agent": userAgent ?? undefined, [APP_SOCKET_HEADER]: appSocketTag } },
      undefined,
      reservation,
    );
    // The sweep already ran while this `101` was being written: it ends now, so the listener's
    // close is not held open by a socket no sweep will ever reach.
    if (retired) wiring.closeSocket?.(socket);
  };
  const retire = () => {
    retired = true;
  };
  return { admit, release, opened, retire };
}
