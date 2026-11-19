import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { startRelay, connectHostToRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { HostId, ServerMessage, type ClientMessage } from "@ace/protocol";

/**
 * A whole ace account on loopback for the iOS app (screenshots and manual checks): a fake account
 * backend and the real Node relay on one origin, as ace's hosted relay serves them, and one
 * account machine whose stand-in daemon asks for machine code 2468 and then forwards the channel
 * to the loopback fake daemon (`bun run spike:daemon`). No provider, WorkOS or quota is involved.
 *
 *   bun run spike:daemon &   # port 9841
 *   node scripts/relay-account-fixture.ts 8790
 *   # build the app with ACE_ACCOUNT_URL=http://127.0.0.1:8790
 *
 * The account has a profile picture (a soft two-colour gradient) unless `--no-picture` is
 * passed, when the avatar shows the account's initials.
 */
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const withPicture = !process.argv.includes("--no-picture");
const port = Number(args[0] ?? 8790);
const daemonUrl = args[1] ?? "ws://127.0.0.1:9841";
const origin = `http://127.0.0.1:${port}`;
const relay = await startRelay({ bind: "127.0.0.1" });
const token = () => randomBytes(32).toString("base64url");
const account = {
  id: "acct_fixture",
  email: "arpan@example.com",
  name: "Arpan Bhandari",
  ...(withPicture ? { picture: true } : {}),
};

/** One PNG chunk: its length, type, data and checksum. */
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
/** A 96px PNG, a diagonal gradient, written without an image library. */
function picture(): Buffer {
  const size = 96;
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      rows.push(Math.round(64 + 150 * t), Math.round(110 + 60 * (1 - t)), Math.round(200 - 90 * t));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const session = token();
const logins = new Map<string, string>();

const host = await connectHostToRelay({
  relayUrl: relay.url,
  hostKeys: keyPair(),
  onClientChannel: async (channel) => {
    const hello = await channel.receive();
    if (hello.type !== "hello" || hello.grant === undefined) return channel.close();
    channel.authorize();
    if (hello.machineCode !== "2468") {
      const code = hello.machineCode === undefined ? "machine_code_required" : "machine_code_wrong";
      await channel.send({ type: "error", code, message: "This machine needs its machine code." });
      channel.close();
      return;
    }
    if (hello.compression?.includes("deflate-raw")) channel.compress?.(() => true);
    // The channel from here on is the fake daemon's, with the relay's host id in its welcome.
    const daemon = new WebSocket(daemonUrl);
    daemon.binaryType = "arraybuffer";
    daemon.addEventListener("open", () => {
      const { grant: _grant, machineCode: _code, compression: _compression, ...rest } = hello;
      daemon.send(
        JSON.stringify({ ...rest, deviceId: "ios-spike-device", token: "ios-spike-token" }),
      );
    });
    daemon.addEventListener("message", ({ data }) => {
      if (data instanceof ArrayBuffer)
        return void channel.sendBinary(new Uint8Array(data)).catch(() => {});
      const parsed = ServerMessage.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      const message =
        parsed.data.type === "welcome"
          ? { ...parsed.data, hostId: HostId.parse(host.hostId) }
          : parsed.data;
      void channel.send(message).catch(() => daemon.close());
    });
    daemon.addEventListener("close", () => channel.close());
    void channel.closed.then(() => daemon.close());
    for await (const frame of channel.frames()) {
      if (frame instanceof Uint8Array) daemon.send(Uint8Array.from(frame));
      else daemon.send(JSON.stringify(frame satisfies ClientMessage));
    }
  },
});
let machines = [
  { hostId: host.hostId, name: "studio", platform: "darwin", lastSeenAt: Date.now() },
  {
    hostId: "B".repeat(52),
    name: "build box",
    platform: "linux",
    lastSeenAt: Date.now() - 3 * 3600_000,
  },
];

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
function authorized(request: IncomingMessage, secret: string) {
  return request.headers.authorization === `Bearer ${secret}`;
}
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", origin);
  const path = url.pathname;
  if (request.method === "POST" && path === "/v1/account/login") {
    const id = token();
    const secret = token();
    logins.set(id, secret);
    return reply(response, 200, {
      id,
      secret,
      loginUrl: `${origin}/v1/account/login?id=${id}`,
      expiresAt: Date.now() + 600_000,
    });
  }
  if (request.method === "GET" && path === "/v1/account/login")
    return void response
      .writeHead(200, { "content-type": "text/html" })
      .end("<p>Signed in to ace.</p>");
  const login = /^\/v1\/account\/login\/([\w-]+)$/.exec(path);
  if (login) {
    const secret = logins.get(login[1] ?? "");
    if (!secret || !authorized(request, secret)) return reply(response, 401, {});
    if (request.method === "DELETE") return reply(response, 200, {});
    return reply(response, 200, {
      status: "complete",
      session: { account, token: session, expiresAt: Date.now() + 30 * 86400_000 },
    });
  }
  if (!authorized(request, session)) return reply(response, 401, {});
  if (path === "/v1/account/session")
    return reply(
      response,
      200,
      request.method === "DELETE" ? {} : { account, expiresAt: Date.now() + 86400_000 },
    );
  if (request.method === "GET" && path === "/v1/account/picture") {
    if (!withPicture) return reply(response, 404, {});
    return void response.writeHead(200, { "content-type": "image/png" }).end(picture());
  }
  if (request.method === "POST" && path === "/v1/grants")
    return reply(response, 200, { token: `grant.${token()}`, expiresAt: Date.now() + 300_000 });
  if (request.method === "GET" && path === "/v1/machines")
    return reply(response, 200, { machines });
  const forget = /^\/v1\/machines\/([A-Z2-7]{52})$/.exec(path);
  if (request.method === "DELETE" && forget) {
    machines = machines.filter((machine) => machine.hostId !== forget[1]);
    return reply(response, 200, {});
  }
  reply(response, 404, {});
});
// WebSocket upgrades (`/client`, `/host`, `/join`) go to the relay, as on the hosted origin.
server.on("upgrade", (request, socket, head) => {
  const target = connect(
    new URL(relay.url).port ? Number(new URL(relay.url).port) : 80,
    "127.0.0.1",
    () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2)
        lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      target.write(lines.join("\r\n") + "\r\n\r\n");
      target.write(head);
      socket.pipe(target).pipe(socket);
    },
  );
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
});
server.listen(port, "127.0.0.1", () =>
  process.stdout.write(`account ${origin} relay ${relay.url} machine ${host.hostId}\n`),
);
const stop = async () => {
  server.close();
  await host.close();
  await relay.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
