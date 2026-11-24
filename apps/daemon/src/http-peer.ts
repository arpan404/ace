import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";

/** Who sent an HTTP request and which ports carried it, as the transport saw them. */
export interface HttpPeer {
  address: string;
  remotePort: number;
  localPort: number;
  /** The TLS name the client asked for, or null with no SNI (or a plain connection). */
  servername: string | null;
  /** Whether the native listener's proxy hop established these facts (T1b.2). */
  viaHop: boolean;
}

/** A peer the transport established itself, for requests whose socket says something else. */
const peers = new WeakMap<IncomingMessage, HttpPeer>();

/**
 * The peer behind `request`: set by the transport when it knows better, else what the request's
 * socket reports. Every read of an address or port goes through here, so a transport that is not
 * the request's socket can still say who called.
 */
export function peerOf(request: IncomingMessage): HttpPeer {
  const peer = peers.get(request);
  if (peer) return peer;
  const socket = request.socket;
  return {
    address: socket.remoteAddress ?? "unknown",
    remotePort: socket.remotePort ?? 0,
    localPort: socket.localPort ?? 0,
    servername:
      socket instanceof TLSSocket && typeof socket.servername === "string"
        ? socket.servername
        : null,
    viaHop: false,
  };
}

/** Records the peer the transport established for `request`. */
export function setPeer(request: IncomingMessage, peer: HttpPeer): void {
  peers.set(request, peer);
}
