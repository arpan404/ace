import { DeviceCredential } from "@ace/protocol";
import { Agent, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect, type ConnectionOptions } from "node:tls";
import { X509Certificate } from "node:crypto";
import { WebSocket } from "ws";
import { publicKeyFingerprint } from "./tls-identity.ts";

/** Handshake pinning happens before HTTP headers or credentials are written. */
export function pinnedAgent(fingerprint: string): Agent {
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
          throw new Error("TLS public-key fingerprint mismatch");
        if (
          Date.now() < Date.parse(certificate.validFrom) ||
          Date.now() >= Date.parse(certificate.validTo)
        )
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
export async function accessRequest(
  origin: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown; fingerprint?: string } = {},
): Promise<unknown> {
  const url = new URL(path, origin);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Credentials must not be placed in request URLs");
  const tls = url.protocol === "https:";
  if (!tls && (url.protocol !== "http:" || url.hostname !== "127.0.0.1"))
    throw new Error("Remote requests require pinned HTTPS");
  if (tls && !options.fingerprint)
    throw new Error("Remote requests require a public-key fingerprint");
  const agent = tls && options.fingerprint ? pinnedAgent(options.fingerprint) : undefined;
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
            if (bytes > 1024 * 1024) response.destroy(new Error("Response too large"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            if (response.statusCode !== 200) {
              reject(new Error(`HTTP ${response.statusCode}: ${body}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error("Invalid JSON response"));
            }
          });
        },
      );
      request.setTimeout(10_000, () => request.destroy(new Error("Request timed out")));
      request.on("error", reject);
      request.end(data);
    });
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
export function ticketSocket(origin: string, fingerprint: string): WebSocket {
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
  const agent = pinnedAgent(fingerprint);
  const socket = new WebSocket(url, { agent });
  socket.once("close", () => agent.destroy());
  return socket;
}
