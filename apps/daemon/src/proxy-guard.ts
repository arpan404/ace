// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { setPeer } from "./http-peer.ts";

export type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/** The four headers the native listener's proxy hop reserves for itself (ADR 0226, T1a.2). */
const HOP_SECRET = "x-ace-hop-secret";
const HOP_PEER_ADDRESS = "x-ace-hop-peer-address";
const HOP_PEER_PORT = "x-ace-hop-peer-port";
const HOP_LOCAL_PORT = "x-ace-hop-local-port";
/** The allowlist: these and only these are the hop's own, so these and only these it removes. */
const HOP_HEADERS = [HOP_SECRET, HOP_PEER_ADDRESS, HOP_PEER_PORT, HOP_LOCAL_PORT] as const;

/** The addresses a request from this machine's own listener can carry (IPv6 included). */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * A header's one value, or `undefined` when it is missing or was sent more than once. Read from
 * `rawHeaders`, because `headers` joins duplicates with `, ` and a repeated secret must be seen.
 */
function oneValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.rawHeaders;
  let found: string | undefined;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() !== name) continue;
    if (found !== undefined) return undefined;
    found = raw[index + 1];
  }
  return found;
}

/** The secret compared in constant time, over equal-length buffers only. */
function secretMatches(given: string, secret: string): boolean {
  const left = Buffer.from(given, "utf8");
  const right = Buffer.from(secret, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A hop port as the proxy writes it: decimal, 1 to 65535, nothing else. */
function hopPort(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d{0,4}$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65_535 ? port : undefined;
}

function refuse(response: ServerResponse): void {
  response.writeHead(403, { "Content-Length": "0", Connection: "close" });
  response.end();
}

/**
 * The internal server's only door (ADR 0226, T1a.7). The native listener's proxy hop is the one
 * caller: its request arrives from loopback carrying this boot's secret and the client's real
 * peer fields. Everything else — a request straight to the internal port, a wrong or repeated
 * secret, a missing or malformed peer field — is refused with `403` and never reaches the chain.
 * A valid one loses the four hop headers, has its peer recorded (`setPeer`), and is dispatched to
 * the chain, whose own authentication (bearer, org gate) runs unchanged.
 */
export function proxyGuard(secret: string, handler: Handler): Handler {
  return (request, response) => {
    const address = request.socket.remoteAddress;
    if (address === undefined || !LOOPBACK.has(address)) {
      refuse(response);
      return;
    }
    const given = oneValue(request, HOP_SECRET);
    const peerAddress = oneValue(request, HOP_PEER_ADDRESS);
    const remotePort = hopPort(oneValue(request, HOP_PEER_PORT));
    const localPort = hopPort(oneValue(request, HOP_LOCAL_PORT));
    if (
      given === undefined ||
      !secretMatches(given, secret) ||
      peerAddress === undefined ||
      isIP(peerAddress) === 0 ||
      remotePort === undefined ||
      localPort === undefined
    ) {
      refuse(response);
      return;
    }
    for (const name of HOP_HEADERS) delete request.headers[name];
    request.rawHeaders = withoutHopHeaders(request.rawHeaders);
    setPeer(request, { address: peerAddress, remotePort, localPort });
    handler(request, response);
  };
}

/** The raw header list with every hop pair removed, so nothing downstream can read one back. */
function withoutHopHeaders(raw: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name === undefined || value === undefined) continue;
    if ((HOP_HEADERS as readonly string[]).includes(name.toLowerCase())) continue;
    kept.push(name, value);
  }
  return kept;
}
