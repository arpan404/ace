import { DeviceCredential } from "@ace/protocol";
import { parsePairingLink } from "@ace/client/access";
import { Agent, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { checkServerIdentity, connect, type ConnectionOptions } from "node:tls";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { publicKeyFingerprint } from "./tls-identity.ts";
import {
  ClientError,
  accessResponseError,
  webSocketTransport,
  type TransportEvents,
} from "@ace/client";

const AccessFailureBody = z.object({ error: z.string().min(1) });
/** The daemon's refusal text is actionable (for example "Turn on remote access"), so keep it. */
function accessFailure(status: number, body: string): ClientError {
  const failure = accessResponseError(status);
  let detail: string | undefined;
  try {
    detail = AccessFailureBody.safeParse(JSON.parse(body)).data?.error;
  } catch {
    detail = undefined;
  }
  return detail === undefined
    ? failure
    : new ClientError(failure.code, `${failure.message}: ${detail.slice(0, 512)}`);
}

/** A Tailscale MagicDNS name (`mac.tailnet.ts.net`), whose certificate only that machine can get. */
function tailnetName(host: string | undefined): string | undefined {
  const name = host?.toLowerCase().replace(/\.$/, "");
  return name && isIP(name) === 0 && name.endsWith(".ts.net") ? name : undefined;
}

/**
 * Handshake pinning happens before HTTP headers or credentials are written. The pinned public key
 * authenticates ace's own certificate. A ts.net host may instead present the publicly trusted
 * certificate Tailscale issues for that exact name, which rotates its key on renewal (ADR 0097).
 * `roots` replaces the system's certificate authorities, for tests only.
 */
export function pinnedAgent(
  fingerprint: string,
  now: () => number = Date.now,
  roots?: string[],
): Agent {
  const connector = pinnedConnector(fingerprint, now, roots);
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = connector;
  return agent;
}

/** TLS sessions kept from pinned handshakes, so the next connection to that key can resume. */
export interface PinnedSessions {
  get(): Buffer | undefined;
  set(session: Buffer): void;
}

/**
 * A pinned agent that keeps its connections open between requests and resumes TLS sessions from
 * `sessions`. Every new socket, resumed or not, passes the same pin check before it is used; a
 * session is kept only from a socket that passed it.
 */
export function pinnedKeepAliveAgent(
  fingerprint: string,
  sessions: PinnedSessions,
  now: () => number = Date.now,
  roots?: string[],
): Agent {
  const connector = pinnedConnector(fingerprint, now, roots, sessions);
  const agent = new Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 2 });
  agent.createConnection = connector;
  return agent;
}

function pinnedConnector(
  fingerprint: string,
  now: () => number,
  roots: string[] | undefined,
  sessions?: PinnedSessions,
): Agent["createConnection"] {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid public-key fingerprint");
  return (options: ConnectionOptions, callback) => {
    const resume = sessions?.get();
    const socket = connect({
      ...options,
      rejectUnauthorized: false,
      ...(roots ? { ca: roots } : {}),
      ...(resume ? { session: resume } : {}),
    });
    let complete = false;
    let pinned = false;
    let offered: Buffer | undefined;
    // TLS 1.3 sends tickets after the handshake: one is kept only once this socket is pinned.
    if (sessions)
      socket.on("session", (session: Buffer) => {
        if (pinned) sessions.set(session);
        else offered = session;
      });
    const finish = (error?: Error) => {
      if (complete) return;
      complete = true;
      clearTimeout(deadline);
      if (error) {
        socket.destroy();
        callback?.(error, socket);
      } else {
        pinned = true;
        if (offered) sessions?.set(offered);
        callback?.(null, socket);
      }
    };
    const deadline = setTimeout(() => finish(new Error("TLS handshake timed out")), 10_000);
    deadline.unref();
    socket.once("error", finish);
    socket.once("secureConnect", () => {
      try {
        const peer = socket.getPeerCertificate();
        const certificate = new X509Certificate(peer.raw);
        const name = tailnetName(options.servername ?? options.host ?? undefined);
        const trustedName =
          name !== undefined && socket.authorized && checkServerIdentity(name, peer) === undefined;
        if (publicKeyFingerprint(certificate.raw) !== fingerprint && !trustedName)
          throw new ClientError("auth", "TLS public-key fingerprint mismatch");
        const at = now();
        if (at < Date.parse(certificate.validFrom) || at >= Date.parse(certificate.validTo))
          throw new ClientError("auth", "TLS certificate expired or not yet valid");
        finish();
      } catch (error) {
        finish(error instanceof ClientError ? error : new ClientError("auth", "TLS pin failed"));
      }
    });
    return undefined;
  };
}
export async function accessRequest(
  origin: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    fingerprint?: string;
    now?: () => number;
  } = {},
): Promise<unknown> {
  const url = new URL(path, origin);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Credentials must not be placed in request URLs");
  const tls = url.protocol === "https:";
  if (!tls && (url.protocol !== "http:" || url.hostname !== "127.0.0.1"))
    throw new Error("Remote requests require pinned HTTPS");
  if (tls && !options.fingerprint)
    throw new Error("Remote requests require a public-key fingerprint");
  const agent =
    tls && options.fingerprint ? pinnedAgent(options.fingerprint, options.now) : undefined;
  const data = options.body === undefined ? undefined : JSON.stringify(options.body);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = (tls ? httpsRequest : httpRequest)(
        url,
        {
          method: options.method ?? "GET",
          ...(agent ? { agent } : {}),
          headers: {
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(data === undefined
              ? {}
              : { "content-type": "application/json", "content-length": Buffer.byteLength(data) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024)
              response.destroy(new ClientError("limit", "Response too large"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            if (response.statusCode !== 200) {
              reject(
                response.statusCode === undefined
                  ? new ClientError("protocol")
                  : accessFailure(response.statusCode, body),
              );
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new ClientError("protocol", "Invalid JSON response"));
            }
          });
        },
      );
      request.setTimeout(10_000, () => request.destroy(new Error("Request timed out")));
      request.on("error", reject);
      request.end(data);
    });
  } catch (error) {
    throw error instanceof ClientError
      ? error
      : new ClientError("offline", "Access transport unavailable");
  } finally {
    agent?.destroy();
  }
}
/** `installId`: the redeeming install (ADR 0115); pairing it again keeps its one device. */
export async function redeemPairing(
  url: string,
  name: string,
  installId?: string,
): Promise<DeviceCredential> {
  const link = parsePairingLink(url);
  if (!link.daemon.startsWith("https:"))
    throw new Error("Pairing requires an HTTPS URL with credentials in its fragment");
  return DeviceCredential.parse(
    await accessRequest(new URL(link.daemon).origin, "/v1/pair", {
      method: "POST",
      fingerprint: link.fingerprint,
      body: { code: link.code, name, ...(installId ? { installId } : {}) },
    }),
  );
}
export function ticketSocket(
  origin: string,
  fingerprint: string,
  now: () => number = Date.now,
): WebSocket {
  const url = new URL(origin);
  if (
    url.protocol !== "wss:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Socket requires a pinned WSS origin without credentials");
  const agent = pinnedAgent(fingerprint, now);
  const socket = new WebSocket(url, { agent });
  socket.once("close", () => agent.destroy());
  return socket;
}
/** The SDK owns reconnect; pin rejection must reach it before generic socket error handling. */
export function pinnedSocketTransport(origin: string, fingerprint: string) {
  let observer: TransportEvents | undefined;
  const transport = webSocketTransport(() => {
    const current = observer;
    const socket = ticketSocket(origin, fingerprint);
    socket.on("error", (error) => {
      if (observer === current && error instanceof ClientError && error.code === "auth")
        current?.close(4001);
    });
    return socket;
  });
  return {
    supportsBinary: true,
    open(events: TransportEvents) {
      observer = events;
      transport.open(events);
    },
    send(text: string) {
      transport.send(text);
    },
    close() {
      observer = undefined;
      transport.close();
    },
  };
}
