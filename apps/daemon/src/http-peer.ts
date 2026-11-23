import type { IncomingMessage } from "node:http";

/** Who sent an HTTP request and which ports carried it, as the transport saw them. */
export interface HttpPeer {
  address: string;
  remotePort: number;
  localPort: number;
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
  return {
    address: request.socket.remoteAddress ?? "unknown",
    remotePort: request.socket.remotePort ?? 0,
    localPort: request.socket.localPort ?? 0,
  };
}

/** Records the peer the transport established for `request`. */
export function setPeer(request: IncomingMessage, peer: HttpPeer): void {
  peers.set(request, peer);
}
