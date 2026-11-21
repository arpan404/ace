import {
  accessTicket,
  pairedSocketCredential as sharedPairedSocketCredential,
} from "@ace/client/access-ticket";
import { ticketCredential } from "@ace/client";
import type { AccessOptions } from "@ace/client/access";

/**
 * Fresh single-use tickets for Android paired connections.
 *
 * Wire contract (`docs/daemon/remote-access.md`): on every connection
 * attempt the device exchanges its bearer token for a fresh ticket over
 * pinned HTTPS, then opens pinned WSS to the same daemon and sends
 * `{ type: "hello", protocolVersion: 1, deviceId, ticket }`. Tickets last
 * sixty seconds, are consumed by one hello, and are bound to the paired
 * device ID. Device tokens are rejected in hello; the host token never
 * leaves the loopback listener.
 *
 * The `fetch` implementation is injected because it must be the native
 * pinned fetch (parity task A02.02): it enforces the SPKI pin and validity
 * window from `../security/trust.ts`, refuses redirects, and bounds
 * responses at 1 MiB before any credential is written. The React Native
 * default fetch/WebSocket must never carry pairing material.
 */

export type PinnedFetch = AccessOptions["fetch"];

/** Convert a daemon HTTPS origin to its WSS socket URL. Rejects credentials, paths and cleartext. */
export function socketUrlFor(daemonOrigin: string): string {
  let url: URL;
  try {
    url = new URL(daemonOrigin);
  } catch {
    throw new Error("A paired computer needs an HTTPS address");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("A paired computer address carries no credentials");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("A paired computer needs the daemon address itself");
  }
  // Like iOS (`MachineAccess.connectionTarget`, `PinnedHTTP.urlRequest`),
  // pairing never uses cleartext: loopback included, the daemon speaks HTTPS.
  if (url.protocol === "https:") return `wss://${url.host}/`;
  throw new Error("A paired computer needs an HTTPS address");
}

/**
 * Exchange one device token for a fresh single-use ticket. Each connection
 * attempt calls this again; tickets are never cached or reused.
 */
export async function exchangeTicket(input: {
  daemonOrigin: string;
  token: () => Promise<string>;
  fetch: PinnedFetch;
  signal?: AbortSignal;
}): Promise<{ ticket: string; expiresAt: number }> {
  return accessTicket(
    { origin: input.daemonOrigin, token: input.token, fetch: input.fetch },
    input.signal,
  );
}

/**
 * Socket authentication for one paired device. Each dial exchanges a fresh
 * single-use ticket through the injected pinned fetch; pin rejection reaches
 * the caller as an `auth` failure before generic socket error handling.
 */
export function pairedSocketCredential(input: {
  socketUrl: string;
  token: () => Promise<string>;
  fetch: PinnedFetch;
}): () => Promise<{ ticket: string }> {
  return sharedPairedSocketCredential({
    url: input.socketUrl,
    token: input.token,
    fetch: input.fetch,
  });
}

/**
 * Retry-safe credential exchange for the SDK transport: re-reads the stored
 * device token on every attempt so revocation and re-pairing take effect
 * without restarting the app.
 */
export function reconnectCredential(input: {
  loadToken: () => Promise<string>;
  exchange: (token: string) => Promise<unknown>;
}): () => Promise<{ ticket: string }> {
  return ticketCredential(input.loadToken, input.exchange);
}
