import { WebSocket } from "ws";
import type { DeliveryRuntime } from "./delivery-runtime.ts";

/**
 * Bound for a deliberate close frame to reach its peer before the socket is
 * dropped. The timer is injected, so tests advance it by hand; production
 * passes the daemon's own delay.
 */
export const DAEMON_CLOSE_GRACE_MS = 1_000;

type Delay = DeliveryRuntime["delay"];

interface Grace {
  closeSent: boolean;
  cancel: () => void;
}

export interface SocketCloser {
  /** Send `code`/`reason` when the socket can carry it, then bound the drop. */
  gracefulClose(socket: WebSocket, code: number, reason: string): void;
  /** The error path's share of the same bound (a `1009` already on the wire). */
  boundClosingSocket(socket: WebSocket): void;
}

/**
 * One owner per daemon server: close state lives in this closure, never in a
 * module global. Immediate session cleanup still happens first at the call
 * site; this owner only conducts the wire goodbye. Idempotent per socket: a
 * second call never resends the frame. Sockets already `CLOSING` keep their
 * own code and only gain the bound; `CONNECTING` sockets gain the bound and
 * a later sweep delivers the code once `OPEN`.
 */
export function createSocketCloser(
  delay: Delay,
  graceMs: number = DAEMON_CLOSE_GRACE_MS,
): SocketCloser {
  const grace = new WeakMap<WebSocket, Grace>();

  const cancel = (socket: WebSocket): void => {
    const entry = grace.get(socket);
    if (!entry) return;
    grace.delete(socket);
    try {
      entry.cancel();
    } catch {
      /* The deadline already fired. */
    }
  };

  const drop = (socket: WebSocket): void => {
    cancel(socket);
    try {
      socket.terminate();
    } catch {
      /* Already gone; the close told the peer why. */
    }
  };

  const arm = (socket: WebSocket, closeSent: boolean): void => {
    const existing = grace.get(socket);
    if (existing) {
      if (closeSent && !existing.closeSent) {
        // The frame went out late (an upgrade that just opened): restart the
        // bound so the just-sent frame gets its full flush window.
        existing.closeSent = true;
        try {
          existing.cancel();
        } catch {
          /* The deadline already fired. */
        }
        existing.cancel = delay(() => drop(socket), graceMs);
      }
      return;
    }
    const entry: Grace = { closeSent, cancel: () => {} };
    entry.cancel = delay(() => drop(socket), graceMs);
    grace.set(socket, entry);
    socket.once("close", () => cancel(socket));
  };

  const gracefulClose = (socket: WebSocket, code: number, reason: string): void => {
    if (grace.get(socket)?.closeSent) return;
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.close(code, reason);
      } catch {
        drop(socket);
        return;
      }
      arm(socket, true);
    } else if (
      socket.readyState === WebSocket.CLOSING ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      arm(socket, false);
    }
    // CLOSED: nothing to deliver or bound.
  };

  const boundClosingSocket = (socket: WebSocket): void => {
    if (socket.readyState === WebSocket.CLOSING) {
      arm(socket, false);
      return;
    }
    if (socket.readyState !== WebSocket.CLOSED) drop(socket);
  };

  return { gracefulClose, boundClosingSocket };
}
