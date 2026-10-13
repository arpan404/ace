import { DeviceCredential } from "@ace/protocol";
import { Agent, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect, type ConnectionOptions } from "node:tls";
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

/** Handshake pinning happens before HTTP headers or credentials are written. */
export function pinnedAgent(fingerprint: string, now: () => number = Date.now): Agent {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid public-key fingerprint");
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (options: ConnectionOptions, callback) => {
    const socket = connect({ ...options, rejectUnauthorized: false });
    let complete = false;
    const finish = (error?: Error) => {
      if (complete) return;
      complete = true;
      clearTimeout(deadline);
      if (error) {
        socket.destroy();
        callback?.(error, socket);
      } else callback?.(null, socket);
    };
    const deadline = setTimeout(() => finish(new Error("TLS handshake timed out")), 10_000);
    deadline.unref();
    socket.once("error", finish);
    socket.once("secureConnect", () => {
      try {
        const certificate = new X509Certificate(socket.getPeerCertificate().raw);
        if (publicKeyFingerprint(certificate.raw) !== fingerprint)
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
  return agent;
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
export async function redeemPairing(url: string, name: string): Promise<DeviceCredential> {
  const pairing = new URL(url);
  if (pairing.protocol !== "https:" || pairing.search)
    throw new Error("Pairing requires an HTTPS URL with credentials in its fragment");
  const fragment = new URLSearchParams(pairing.hash.slice(1));
  return DeviceCredential.parse(
    await accessRequest(pairing.origin, "/v1/pair", {
      method: "POST",
      fingerprint: fragment.get("fingerprint") ?? "",
      body: { code: fragment.get("code"), name },
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
