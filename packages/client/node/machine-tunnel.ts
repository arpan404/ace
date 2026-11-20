import { createHash, X509Certificate } from "node:crypto";
import { Agent, request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity, connect, type ConnectionOptions } from "node:tls";
import { WebSocket } from "ws";
import type { PortableSocket } from "../src/portable-relay.ts";
import type { TunnelDialer } from "../src/machine-tunnel-paths.ts";

/*
 * The tunnel's dialer on Node (ADR 0194), for the desktop app's main process: the same pinned
 * TLS check the rest of ace makes on a direct path (ADR 0114). The certificate's public key must
 * hash to the path's fingerprint, or, on a ts.net name, be Tailscale's publicly trusted
 * certificate for that exact name (ADR 0097); any other certificate fails the handshake before
 * a byte of HTTP or a credential is written. Kept outside `src/`, which browsers bundle.
 */

const spkiFingerprint = (raw: Buffer) =>
  createHash("sha256")
    .update(new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");

const tailnetName = (host: string | undefined) =>
  host && !isIP(host) && host.toLowerCase().endsWith(".ts.net") ? host : undefined;

export interface NodeTunnelDialerOptions {
  /** The wall clock the certificate's validity is checked against. */
  now?: () => number;
  /** Replaces the system's certificate authorities for the ts.net check; tests only. */
  roots?: string[];
  /** How long a pinned TLS handshake may take; 10 s unless given. */
  handshakeMs?: number;
}

/** An HTTPS agent whose every connection is pinned to `fingerprint`. */
export function pinnedTunnelAgent(
  fingerprint: string,
  options: NodeTunnelDialerOptions = {},
): Agent {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid public-key fingerprint");
  const now = options.now ?? Date.now;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (connection: ConnectionOptions, callback) => {
    const socket = connect({
      ...connection,
      rejectUnauthorized: false,
      ...(options.roots ? { ca: options.roots } : {}),
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        socket.destroy();
        callback?.(error, socket);
      } else callback?.(null, socket);
    };
    const deadline = setTimeout(
      () => finish(new Error("TLS handshake timed out")),
      options.handshakeMs ?? 10_000,
    );
    deadline.unref();
    socket.once("error", finish);
    socket.once("secureConnect", () => {
      try {
        const peer = socket.getPeerCertificate();
        const name = tailnetName(connection.servername ?? connection.host ?? undefined);
        const trustedName =
          name !== undefined && socket.authorized && checkServerIdentity(name, peer) === undefined;
        if (spkiFingerprint(peer.raw) !== fingerprint && !trustedName)
          throw new Error("TLS public-key fingerprint mismatch");
        const certificate = new X509Certificate(peer.raw);
        const at = now();
        if (at < Date.parse(certificate.validFrom) || at >= Date.parse(certificate.validTo))
          throw new Error("TLS certificate expired or not yet valid");
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("TLS pin failed"));
      }
    });
    return undefined;
  };
  return agent;
}

/** `fetch` for the ticket exchange, over a pinned connection; enough of it for `accessHttp`. */
function pinnedFetch(agent: Agent) {
  return (input: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const headers = new Headers(init.headers);
      const outgoing = request(
        input,
        { method: init.method ?? "GET", agent, headers: Object.fromEntries(headers) },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            // A ticket answer is tiny; anything large is not one.
            if (size > 64 * 1024) incoming.destroy(new Error("Ticket answer too large"));
            else chunks.push(chunk);
          });
          incoming.once("error", reject);
          incoming.once("end", () =>
            resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 502 })),
          );
        },
      );
      outgoing.once("error", reject);
      init.signal?.addEventListener("abort", () => outgoing.destroy(new Error("aborted")), {
        once: true,
      });
      if (typeof init.body === "string") outgoing.end(init.body);
      else outgoing.end();
    });
}

/** The tunnel's dialer for Node callers: pinned direct sockets and fetch, plain relay sockets. */
export function nodeTunnelDialer(options: NodeTunnelDialerOptions = {}): TunnelDialer {
  return {
    direct(url, fingerprint) {
      const agent = pinnedTunnelAgent(fingerprint, options);
      const socket = new WebSocket(url, { agent });
      socket.once("close", () => agent.destroy());
      return socket as unknown as PortableSocket;
    },
    directFetch: (fingerprint) => pinnedFetch(pinnedTunnelAgent(fingerprint, options)),
    relay: (url, protocols) => new WebSocket(url, protocols) as unknown as PortableSocket,
  };
}
