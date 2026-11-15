import type { MainSocket } from "./main-socket.ts";

/*
 * What the daemon can tell about one main socket's link without sending anything new.
 *
 * The daemon has no per-socket round-trip measure today: clients ping and the daemon only
 * answers, and a ws send callback fires when bytes reach the kernel, not the peer. So the one
 * signal is backlog: bytes the socket accepted and has not yet written (`bufferedAmount`; on a
 * relayed channel, the bytes the channel still holds). A link slower than what the daemon sends
 * builds a backlog; a fast one drains it between writes.
 *
 * One estimate per socket, sampled by its outbox on every write; anything else that wants to
 * know how a socket's link is doing reads it here (`linkEstimate`) rather than measuring again.
 * It is never sent to a client.
 */

/** A read-only view of one socket's link. */
export interface LinkView {
  /** Not loopback: a LAN, Tailscale or relayed socket. */
  readonly remote: boolean;
  /** Bytes accepted and not yet written to the network, right now. */
  readonly backlogBytes: number;
  /** The backlog smoothed over recent writes (each write weighs a quarter). */
  readonly smoothedBacklogBytes: number;
  /** A measured round trip, in milliseconds; undefined: there is no measurement (see above). */
  readonly roundTripMs: number | undefined;
}

class LinkEstimate implements LinkView {
  readonly remote: boolean;
  readonly roundTripMs = undefined;
  #socket: Pick<MainSocket, "bufferedAmount">;
  #smoothed = 0;
  constructor(socket: Pick<MainSocket, "bufferedAmount">, remote: boolean) {
    this.#socket = socket;
    this.remote = remote;
  }
  get backlogBytes(): number {
    return this.#socket.bufferedAmount;
  }
  get smoothedBacklogBytes(): number {
    return this.#smoothed;
  }
  sample(): void {
    this.#smoothed += (this.#socket.bufferedAmount - this.#smoothed) / 4;
  }
}

const estimates = new WeakMap<Pick<MainSocket, "bufferedAmount">, LinkEstimate>();

/**
 * Start estimating `socket`'s link (once; a second call returns the same estimate) and return
 * a function the socket's writer calls after each write to sample it.
 */
export function trackLink(
  socket: Pick<MainSocket, "bufferedAmount">,
  remote: boolean,
): { view: LinkView; sample(): void } {
  let estimate = estimates.get(socket);
  if (!estimate) {
    estimate = new LinkEstimate(socket, remote);
    estimates.set(socket, estimate);
  }
  const tracked = estimate;
  return { view: tracked, sample: () => tracked.sample() };
}

/** How `socket`'s link is doing, or undefined while nothing writes to it through an outbox. */
export function linkEstimate(socket: Pick<MainSocket, "bufferedAmount">): LinkView | undefined {
  return estimates.get(socket);
}
