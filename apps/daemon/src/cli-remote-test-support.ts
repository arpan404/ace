import { once } from "node:events";
import { createServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, ServerMessage, PairingResponse, type Command } from "@ace/protocol";
import { daemonFixture } from "./agent-control/daemon-test-support.ts";
import { accessRequest, redeemPairing, ticketSocket } from "./client-access.ts";
import { loadIdentity } from "./tls-identity.ts";
import { invoke } from "./cli-test-support.ts";

/** Real pinned edges; the proxy controls ticket outages and lost replies/snapshots. */
export async function remoteCliFixture() {
  const f = await daemonFixture(
    undefined,
    {},
    { ACE_LISTEN: "lan", ACE_REMOTE_PORT: "0", ACE_ADVERTISE_HOST: "127.0.0.1" },
  );
  const home = join(f.h.home, "daemon");
  const hostToken = await readFile(join(home, "daemon-token"), "utf8");
  const local = await readFile(join(home, "daemon-endpoint"), "utf8");
  const pairing = PairingResponse.parse(
    await accessRequest(local, "/v1/pairings", {
      method: "POST",
      token: hostToken,
      // Remote work validates its registered workspace through a projects read.
      body: { scopes: ["read", "operate", "projects"] },
    }),
  );
  const paired = await redeemPairing(pairing.url, "CLI regression");
  const upstreamUrl = f.daemon.remoteUrl;
  if (!upstreamUrl) throw new Error("Remote listener missing");
  const identity = loadIdentity(home);
  let ticketFailures = 0,
    failedTickets = 0,
    dropReply = false,
    dropSnapshot = false,
    lostSnapshots = 0;
  const commands: Command[] = [];
  const receipts: string[] = [];
  const sockets = new Set<WebSocket>();
  const server = createServer({ key: identity.key, cert: identity.cert }, (request, response) => {
    if (request.url !== "/v1/tickets") {
      response.writeHead(404).end();
      return;
    }
    if (ticketFailures > 0) {
      ticketFailures--;
      failedTickets++;
      response.writeHead(503).end("Temporary outage");
      return;
    }
    const authorization = z
      .string()
      .regex(/^Bearer [0-9a-f]{64}$/)
      .safeParse(request.headers.authorization);
    if (!authorization.success) {
      response.writeHead(401).end();
      return;
    }
    void accessRequest(upstreamUrl.replace("wss:", "https:"), "/v1/tickets", {
      method: "POST",
      token: authorization.data.slice(7),
      fingerprint: identity.fingerprint,
    })
      .then((value) =>
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value)),
      )
      .catch(() => response.writeHead(502).end());
  });
  const proxy = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) =>
    proxy.handleUpgrade(request, socket, head, (downstream) =>
      proxy.emit("connection", downstream),
    ),
  );
  proxy.on("connection", (downstream) => {
    const upstream = ticketSocket(upstreamUrl, identity.fingerprint);
    sockets.add(downstream);
    sockets.add(upstream);
    const opened = once(upstream, "open");
    downstream.on("message", (bytes, binary) => {
      if (!binary) {
        const parsed = ClientMessage.parse(JSON.parse(bytes.toString()));
        if (parsed.type === "command") commands.push(parsed.command);
      }
      void opened
        .then(() => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
        })
        .catch(() => downstream.terminate());
    });
    upstream.on("message", (bytes, binary) => {
      if (!binary) {
        const parsed = ServerMessage.parse(JSON.parse(bytes.toString()));
        if (dropSnapshot && parsed.type === "snapshot" && parsed.view.kind === "thread") {
          lostSnapshots++;
          downstream.terminate();
          upstream.terminate();
          return;
        }
        if (parsed.type === "commandResult") {
          receipts.push(parsed.commandId);
          if (dropReply) return;
        }
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes, { binary });
    });
    upstream.on("close", (code, reason) => {
      if ([1005, 1006, 1015].includes(code)) downstream.terminate();
      else downstream.close(code, reason.toString());
    });
    upstream.on("error", () => downstream.terminate());
    downstream.on("close", () => upstream.terminate());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy port");
  const origin = `https://127.0.0.1:${address.port}/`;
  const tokenFile = join(home, "test-device.token");
  await writeFile(tokenFile, paired.token, { mode: 0o600 });
  const added = await invoke(home, [
    "remote",
    "add",
    "test-proxy",
    origin,
    "--fingerprint",
    identity.fingerprint,
    "--device",
    paired.device.id,
    "--token-file",
    tokenFile,
    "--json",
  ]);
  if (added.code !== 0) throw new Error(added.stderr || added.stdout);
  const profileId = z.object({ id: z.uuid() }).parse(JSON.parse(added.stdout)).id;
  return {
    ...f,
    home,
    origin,
    profileId,
    commands,
    receipts,
    remoteArgs: ["--remote", "test-proxy"],
    loseReplies() {
      dropReply = true;
    },
    restoreReplies() {
      dropReply = false;
    },
    interruptWithTicketFailure() {
      ticketFailures = 1;
      for (const socket of sockets) socket.terminate();
    },
    failedTickets: () => failedTickets,
    interruptBeforeSnapshots() {
      dropSnapshot = true;
    },
    lostSnapshots: () => lostSnapshots,
    async revoke() {
      await accessRequest(local, `/v1/devices/${paired.device.id}`, {
        method: "DELETE",
        token: hostToken,
      });
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.daemon.close();
    },
  };
}
