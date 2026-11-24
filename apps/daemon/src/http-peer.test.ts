import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import { peerAddress, peerOf, setPeer } from "./http-peer.ts";

/** The least a request needs for the peer readers: a socket, and no hop record. */
function request(remoteAddress: string | undefined): IncomingMessage {
  return { socket: { remoteAddress } } as unknown as IncomingMessage;
}

it("a request without a hop keeps the old address and its empty fallback", () => {
  expect(peerAddress(request("127.0.0.1"))).toBe("127.0.0.1");
  // "" is what the Tailscale handler passes on as no peer (`|| undefined`), so OAuth keys the
  // limit by the way in; "unknown" would make every such caller its own bucket.
  expect(peerAddress(request(undefined))).toBe("");
  expect(peerOf(request(undefined)).address).toBe("unknown");
});

it("a hop's established peer is the address limits key on", () => {
  const withHop = request("127.0.0.1");
  setPeer(withHop, {
    address: "100.64.0.5",
    remotePort: 4,
    localPort: 5,
    servername: null,
    viaHop: true,
  });
  expect(peerAddress(withHop)).toBe("100.64.0.5");
});
