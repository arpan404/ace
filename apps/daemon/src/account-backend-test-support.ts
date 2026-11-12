import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { GRANT_LIFETIME_MS, grantPublicKey, signCloudGrant, signGrant } from "@ace/account-grant";

const account = { id: "user_a", email: "a@example.com", name: "A" };
const base64url43 = () => randomBytes(32).toString("base64url");
const GrantBody = z.object({
  kind: z.enum(["machine", "device"]),
  subject: z.string(),
  purpose: z.literal("spade-cloud").optional(),
});

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
const bearer = (request: IncomingMessage) =>
  request.headers.authorization?.replace(/^Bearer /, "") ?? "";

/**
 * A local stand-in for ace's account backend (ADR 0111): published keys, session checks,
 * grants and the sign-in flow, for one account. Never the real backend.
 */
export async function startFakeAccountBackend(now: () => number) {
  const signingKey = { id: "k1", privateKey: new Uint8Array(randomBytes(32)) };
  const token = base64url43();
  const sessions = new Set([token]);
  const grantRequests: z.infer<typeof GrantBody>[] = [];
  const logins = new Map<string, { secret: string; complete: boolean }>();
  let origin = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", origin);
      const signedIn = sessions.has(bearer(request));
      if (url.pathname === "/v1/keys")
        return reply(response, 200, { keys: [grantPublicKey(signingKey)] });
      if (url.pathname === "/v1/account/login" && request.method === "POST") {
        const id = base64url43();
        const secret = base64url43();
        logins.set(id, { secret, complete: false });
        return reply(response, 200, {
          id,
          secret,
          loginUrl: `${origin}/v1/account/login?id=${id}`,
          expiresAt: now() + 600_000,
        });
      }
      const login = /^\/v1\/account\/login\/(.+)$/.exec(url.pathname)?.[1];
      if (login !== undefined) {
        const pending = logins.get(login);
        if (!pending || pending.secret !== bearer(request)) return reply(response, 404, {});
        if (!pending.complete) return reply(response, 200, { status: "pending" });
        logins.delete(login);
        const issued = base64url43();
        sessions.add(issued);
        return reply(response, 200, {
          status: "complete",
          session: { account, expiresAt: now() + 86_400_000, token: issued },
        });
      }
      if (!signedIn) return reply(response, 401, { error: "unauthorized" });
      if (url.pathname === "/v1/account/session" && request.method === "GET")
        return reply(response, 200, { account, expiresAt: now() + 86_400_000 });
      if (url.pathname === "/v1/account/session" && request.method === "DELETE") {
        sessions.delete(bearer(request));
        return reply(response, 200, {});
      }
      if (url.pathname === "/v1/grants" && request.method === "POST") {
        const body = GrantBody.parse(JSON.parse(Buffer.concat(chunks).toString()));
        grantRequests.push(body);
        const exp = now() + GRANT_LIFETIME_MS;
        return reply(response, 200, {
          token: (body.purpose ? signCloudGrant : signGrant)(
            { kind: body.kind, account: account.id, subject: body.subject, iat: now(), exp },
            signingKey,
          ),
          expiresAt: exp,
        });
      }
      reply(response, 404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No backend address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    /** A live session for the one account, as the desktop app would hold it. */
    token,
    account,
    signingKey,
    grantRequests,
    /** Whether a session token is still live at the backend. */
    live: (session: string) => sessions.has(session),
    /** The account signed this session out elsewhere (or deleted it). */
    revoke: (session: string) => sessions.delete(session),
    /** The person finished every pending sign-in in their browser. */
    completeLogins() {
      for (const pending of logins.values()) pending.complete = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
