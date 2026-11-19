import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { GRANT_LIFETIME_MS, grantPublicKey, signGrant } from "@ace/account-grant";
import { startRelay } from "@ace/relay";

/**
 * ace's hosted relay on loopback for a real daemon and the iOS app: a stand-in account backend
 * (signed grants, published keys, sign-in that completes at once, machines listed from their
 * machine grants) and the real Node relay behind one origin. Never the real backend; no WorkOS.
 *
 *   node scripts/relay-daemon-fixture.ts 8791
 *   ACE_HOME=/tmp/ace-relay-daemon ACE_PORT=4299 ACE_ACCOUNT_URL=http://127.0.0.1:8791 \
 *     ACE_HOSTED_RELAY_URL=ws://127.0.0.1:8791 ACE_RELAY_URL=ws://127.0.0.1:8791 node ../daemon/src/cli.ts start
 *   # then `ace login` and `ace machine-code set` with the same environment, and build the app
 *   # with ACE_ACCOUNT_URL=http://127.0.0.1:8791
 */
const port = Number(process.argv[2] ?? 8791);
const origin = `http://127.0.0.1:${port}`;
const relay = await startRelay({ bind: "127.0.0.1" });
const relayPort = Number(new URL(relay.url).port);
const signingKey = { id: "k1", privateKey: new Uint8Array(randomBytes(32)) };
const account = { id: "acct_fixture", email: "arpan@example.com", name: "Arpan" };
const id43 = () => randomBytes(32).toString("base64url");
const sessions = new Set<string>();
const logins = new Map<string, string>();
const machines = new Map<
  string,
  { hostId: string; name: string; platform: string; lastSeenAt: number }
>();

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
const bearer = (request: IncomingMessage) =>
  request.headers.authorization?.replace(/^Bearer /, "") ?? "";

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const url = new URL(request.url ?? "/", origin);
    const path = url.pathname;
    process.stdout.write(`${request.method} ${path}\n`);
    if (path === "/v1/keys") return reply(response, 200, { keys: [grantPublicKey(signingKey)] });
    if (request.method === "POST" && path === "/v1/account/login") {
      const id = id43();
      const secret = id43();
      logins.set(id, secret);
      return reply(response, 200, {
        id,
        secret,
        loginUrl: `${origin}/v1/account/login?id=${id}`,
        expiresAt: Date.now() + 600_000,
      });
    }
    if (request.method === "GET" && path === "/v1/account/login")
      return void response.writeHead(200, { "content-type": "text/html" }).end("<p>Signed in.</p>");
    const login = /^\/v1\/account\/login\/([\w-]+)$/.exec(path)?.[1];
    if (login !== undefined) {
      if (logins.get(login) !== bearer(request)) return reply(response, 404, {});
      if (request.method === "DELETE") return reply(response, 200, {});
      logins.delete(login);
      const token = id43();
      sessions.add(token);
      return reply(response, 200, {
        status: "complete",
        session: { account, token, expiresAt: Date.now() + 30 * 86_400_000 },
      });
    }
    if (!sessions.has(bearer(request))) return reply(response, 401, { error: "unauthorized" });
    if (path === "/v1/account/session") {
      if (request.method === "DELETE") sessions.delete(bearer(request));
      return reply(
        response,
        200,
        request.method === "DELETE" ? {} : { account, expiresAt: Date.now() + 86_400_000 },
      );
    }
    if (request.method === "POST" && path === "/v1/grants") {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        kind: "machine" | "device";
        subject: string;
      };
      if (body.kind === "machine")
        machines.set(body.subject, {
          hostId: body.subject,
          name: "studio",
          platform: "darwin",
          lastSeenAt: Date.now(),
        });
      const now = Date.now();
      const exp = now + GRANT_LIFETIME_MS;
      return reply(response, 200, {
        token: signGrant(
          { kind: body.kind, account: account.id, subject: body.subject, iat: now, exp },
          signingKey,
        ),
        expiresAt: exp,
      });
    }
    if (request.method === "GET" && path === "/v1/machines")
      return reply(response, 200, { machines: [...machines.values()] });
    const forget = /^\/v1\/machines\/([A-Z2-7]{52})$/.exec(path)?.[1];
    if (request.method === "DELETE" && forget) {
      machines.delete(forget);
      return reply(response, 200, {});
    }
    reply(response, 404, {});
  });
});
// WebSocket upgrades (`/host`, `/join`, `/client`) go to the relay, as on the hosted origin.
server.on("upgrade", (request, socket, head) => {
  const target = connect(relayPort, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    target.write(lines.join("\r\n") + "\r\n\r\n");
    target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`account and relay ${origin}\n`));
const stop = async () => {
  server.close();
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
