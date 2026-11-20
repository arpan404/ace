/*
 * One mux stream's lifecycle, as TCP closes a connection (ADR 0194, "Stream lifecycle"). Pure:
 * a state and an event give the next state and the actions the mux performs, in order. No I/O
 * and no timers here; the mux owns the socket, the frames and the one deadline.
 *
 * Each direction closes on its own. END means no more DATA that way (a FIN); RESET aborts both
 * ways at once, and whatever either side still queued is discarded. A stream finishes without a
 * RESET only once both ENDs have been exchanged, every byte the peer sent has been written to the
 * local socket, and the local socket has closed.
 */

/** Our direction, local socket to peer: open, END queued behind the bytes still sending, or END sent. */
export type Outbound = "open" | "ending" | "ended";
/**
 * The peer's direction, peer to local socket: open with nothing queued, open with bytes queued for
 * the socket, ended with bytes still queued (the socket ends after them), or ended and the socket
 * ended.
 */
export type Inbound = "open" | "writing" | "draining" | "ended";
/** The local socket: open, or closed after its end (a close without one is an abort). */
export type LocalSocket = "open" | "closed";

export type LiveState = {
  readonly out: Outbound;
  readonly in: Inbound;
  readonly socket: LocalSocket;
};
export type StreamState = LiveState | "gone";

export type LifecycleEvent =
  /** The local socket's reader ended (its FIN). */
  | "localEnd"
  /** Our END frame went, behind every DATA before it. */
  | "endSent"
  /** The local socket closed after its end. */
  | "localClose"
  /** The local side gave up: a close without an end, a socket error, an explicit reset. */
  | "localAbort"
  | "peerData"
  | "peerEnd"
  | "peerReset"
  /** A CREDIT the mux has validated against what it sent; it never changes the lifecycle. */
  | "peerCredit"
  /** Every byte queued for the local socket has been written. */
  | "writesDrained"
  /** The fixed deadline armed when the socket closed with the stream unfinished. */
  | "deadline";

export type LifecycleAction =
  /** Queue our END behind the bytes still sending; `endSent` follows once it went. */
  | "sendEnd"
  /** Queue the DATA for the local socket. */
  | "queueData"
  /** End the local socket (it has been written everything). */
  | "endSocket"
  /** Start the fixed deadline; nothing restarts or extends it. */
  | "armDeadline"
  /** Remove the stream, discarding what it queued, then send RESET. */
  | "reset"
  /** Remove the stream without a frame: it finished, or the peer reset it. */
  | "remove"
  /** The peer broke the protocol: close the whole channel. */
  | "protocolError";

export type Transition = {
  readonly next: StreamState;
  readonly actions: readonly LifecycleAction[];
};

export const outbounds: readonly Outbound[] = ["open", "ending", "ended"];
export const inbounds: readonly Inbound[] = ["open", "writing", "draining", "ended"];
export const lifecycleEvents: readonly LifecycleEvent[] = [
  "localEnd",
  "endSent",
  "localClose",
  "localAbort",
  "peerData",
  "peerEnd",
  "peerReset",
  "peerCredit",
  "writesDrained",
  "deadline",
];

/**
 * Whether a state can be held. A closed socket keeps a stream only while our END may still need
 * to go or the peer's END is awaited, with nothing queued for the socket (bytes the closed socket
 * can never take reset the stream at the close), and never with both ENDs exchanged (finished).
 */
export function reachable(state: LiveState): boolean {
  if (state.socket === "open") return true;
  if (state.out === "open") return false;
  if (state.in === "writing" || state.in === "draining") return false;
  return !(state.out === "ended" && state.in === "ended");
}

/** Every state a stream can be in: the table tests are generated from it. */
export const lifecycleStates: readonly StreamState[] = [
  ...outbounds.flatMap((out) =>
    inbounds.flatMap((inbound) =>
      (["open", "closed"] as const)
        .map((socket): LiveState => ({ out, in: inbound, socket }))
        .filter(reachable),
    ),
  ),
  "gone",
];

export const openState: LiveState = { out: "open", in: "open", socket: "open" };

const stay = (state: StreamState): Transition => ({ next: state, actions: [] });
const gone = (...actions: LifecycleAction[]): Transition => ({ next: "gone", actions });
const to = (state: LiveState, ...actions: LifecycleAction[]): Transition => ({
  next: state,
  actions,
});

export function transition(state: StreamState, event: LifecycleEvent): Transition {
  if (state === "gone") return stay(state);
  const closed = state.socket === "closed";
  const peerEnded = state.in === "draining" || state.in === "ended";
  switch (event) {
    case "localAbort":
      return gone("reset");
    case "peerReset":
      // RESET wins over an END before it: what still waited is dropped.
      return gone("remove");
    case "peerCredit":
      return stay(state);
    case "deadline":
      return closed ? gone("reset") : stay(state);
    case "localEnd":
      if (state.out !== "open" || closed) return stay(state);
      return to({ ...state, out: "ending" }, "sendEnd");
    case "endSent": {
      if (state.out !== "ending") return stay(state);
      const next: LiveState = { ...state, out: "ended" };
      return closed && state.in === "ended" ? gone("remove") : to(next);
    }
    case "localClose":
      if (closed) return stay(state);
      // A close before the socket's end is no graceful close.
      if (state.out === "open") return gone("reset");
      // Bytes the peer sent that the socket never took can't be delivered now.
      if (state.in === "writing" || state.in === "draining") return gone("reset");
      if (state.out === "ended" && state.in === "ended") return gone("remove");
      return to({ ...state, socket: "closed" }, "armDeadline");
    case "peerData":
      if (peerEnded) return to(state, "protocolError");
      // Nothing reads this side any more, as a closed TCP socket answers data with RST.
      if (closed) return gone("reset");
      return to({ ...state, in: "writing" }, "queueData");
    case "peerEnd":
      if (peerEnded) return to(state, "protocolError");
      // After the bytes still waiting to be written, never ahead of them.
      if (state.in === "writing") return to({ ...state, in: "draining" });
      if (!closed) return to({ ...state, in: "ended" }, "endSocket");
      return state.out === "ended" ? gone("remove") : to({ ...state, in: "ended" });
    case "writesDrained":
      if (state.in === "writing") return to({ ...state, in: "open" });
      if (state.in === "draining") return to({ ...state, in: "ended" }, "endSocket");
      return stay(state);
  }
}

export function stateName(state: StreamState): string {
  return state === "gone" ? "gone" : `${state.out}/${state.in}/${state.socket}`;
}
