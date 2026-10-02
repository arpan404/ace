import type { IncomingMessage, ServerResponse } from "node:http";
import { PairingRequest, PairingRedemption, type Device } from "@ace/protocol";
import { AccessError, RemoteAuth } from "./remote-auth.ts";

async function body(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4096) throw new AccessError(413, "Request too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new AccessError(400, "JSON object required");
  }
}
export function accessHttp(
  auth: RemoteAuth,
  authenticate: (token: string) => Device | undefined,
  pairing: () => { origin: string; fingerprint: string } | undefined,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Type", "application/json");
      const path = request.url ?? "";
      // Match exact paths. Credentials and fragments never belong in HTTP URLs.
      const token = request.headers.authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1] ?? "";
      const actor = () => authenticate(token);
      let result: unknown;
      if (path === "/v1/pair" && request.method === "POST") {
        auth.pairingAttempt(request.socket.remoteAddress ?? "unknown");
        const data = PairingRedemption.safeParse(await body(request));
        if (!data.success) throw new AccessError(400, "Invalid pairing redemption");
        result = auth.redeem(data.data.code, data.data.name);
      } else if (path === "/v1/tickets" && request.method === "POST") {
        const device = auth.deviceBearer(token);
        if (!device) throw new AccessError(401, "Device token required");
        result = auth.ticket(device);
      } else {
        auth.requireAdmin(actor());
        if (path === "/v1/status" && request.method === "GET")
          result = { running: true, remote: pairing() ?? null };
        else if (path === "/v1/pairings" && request.method === "POST") {
          const connection = pairing();
          if (!connection)
            throw new AccessError(
              409,
              "Remote access is off. Restart with ACE_LISTEN=lan or ACE_LISTEN=tailscale.",
            );
          const data = PairingRequest.safeParse(await body(request));
          if (!data.success) throw new AccessError(400, "Invalid scopes");
          auth.requireAdmin(actor());
          const { code, expiresAt } = auth.pairing([...new Set(data.data.scopes)]);
          const url = new URL("/pair", connection.origin);
          url.hash = new URLSearchParams({ fingerprint: connection.fingerprint, code }).toString();
          result = { url: url.toString(), expiresAt };
        } else if (path === "/v1/devices" && request.method === "GET") result = auth.list();
        else if (path.startsWith("/v1/devices/") && request.method === "DELETE") {
          if (!auth.revoke(path.slice("/v1/devices/".length)))
            throw new AccessError(404, "Active device not found");
          result = { revoked: true };
        } else throw new AccessError(404, "Unknown endpoint");
      }
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      response.statusCode = error instanceof AccessError ? error.status : 500;
      response.end(
        JSON.stringify({ error: error instanceof AccessError ? error.message : "Request failed" }),
      );
    });
  };
}
