/**
 * A stand-in for `spade-server` that follows spade/docs/ace-integration.md: it holds the data
 * directory's lock, binds `SPADE_LISTEN`, writes `token` and then `server.json` atomically,
 * answers `/health` without a token and everything else only with it, and exits on SIGTERM.
 *
 * - `PUT /v1/ace` `{grant}` → 204, `DELETE /v1/ace` → 204, `GET /v1/ace` → `{grant, connected}`:
 *   the grant for ace, kept in memory (the real Spade keeps it in the OS keychain).
 *
 * Routes for tests:
 * - `GET /v1/env`: its pid, the grant it holds (null when none), how many grants it was handed,
 *   and the names of the `ACE_*` variables it was started with.
 * - `POST /v1/test/ace` → 202: finds ace as Spade does, from `<SPADE_ACE_HOME>/daemon-endpoint`,
 *   and calls `<endpoint>/mcp` with its grant: a ping, then a 2025-11-25 session's list-changed
 *   stream, held open until its first event. `GET /v1/test/ace` → 202 while that runs, then 200
 *   with the MCP URL used, the ping's status, and the stream's status and first event.
 * - `POST /v1/conversations`: `201`, echoing the body it received.
 * - `GET /v1/conversations/{id}/live?after=N`: server-sent events, `stored` with seq N + 1 first.
 * - `POST /v1/conversations/{id}/messages`: `202` with the body's size and SHA-256, and a `delta`
 *   with a small body on open streams.
 * - `GET /v1/images/{n}`: `n` bytes of `image/png` (`imageBytes`).
 * - `POST /v1/crash`: `202`, then exits with code 1.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";

const dataDir = process.env.SPADE_DATA_DIR;
const listen = process.env.SPADE_LISTEN;
if (!dataDir || !listen) process.exit(2);

function holdLock(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    const holder = Number(readFileSync(path, "utf8"));
    try {
      if (holder && holder !== process.pid) {
        process.kill(holder, 0);
        return false;
      }
    } catch {
      /* The holder is gone: take the lock over. */
    }
    writeFileSync(path, String(process.pid), { mode: 0o600 });
    return true;
  }
}
if (!holdLock(join(dataDir, "lock"))) process.exit(3);

const token = randomBytes(32).toString("hex");
const version = "0.1.0-fake";
let grant: string | null = null;
let handed = 0;
let reached: { pending: true } | { found: unknown } | { error: string } | undefined;
/** A stored image `GET /v1/images/{n}` answers: `n` bytes in a fixed pattern. */
const imageBytes = (size: number) =>
  Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + 7) % 256));
const streams = new Map<string, Set<ServerResponse>>();
const send = (response: ServerResponse, event: string, data: unknown) =>
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://spade.invalid");
  if (request.method === "GET" && url.pathname === "/health") {
    // The proof: HMAC-SHA256 of the nonce keyed with the token file's contents.
    const nonce = url.searchParams.get("nonce");
    const proof =
      nonce && /^[0-9a-f]{16,64}$/.test(nonce)
        ? createHmac("sha256", Buffer.from(token, "utf8")).update(nonce, "utf8").digest("hex")
        : undefined;
    return json(response, 200, { ok: true, version, api: 1, ...(proof ? { proof } : {}) });
  }
  if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, {});
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const live = /^\/v1\/conversations\/([^/]+)\/live$/.exec(url.pathname);
    const messages = /^\/v1\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method === "GET" && url.pathname === "/v1/env")
      return json(response, 200, {
        pid: process.pid,
        grant,
        handed,
        aceKeys: Object.keys(process.env).filter((key) => key.startsWith("ACE_")),
      });
    if (url.pathname === "/v1/test/ace") {
      if (request.method === "POST") {
        reached = { pending: true };
        reachAce().then(
          (found) => (reached = { found }),
          (error: unknown) => (reached = { error: String(error) }),
        );
        return json(response, 202, {});
      }
      if (!reached || "pending" in reached) return json(response, 202, {});
      return "found" in reached
        ? json(response, 200, reached.found)
        : json(response, 502, { error: reached.error });
    }
    if (url.pathname === "/v1/ace") {
      if (request.method === "GET")
        return json(response, 200, { grant: grant !== null, connected: false });
      if (request.method === "DELETE") {
        grant = null;
        response.writeHead(204).end();
        return;
      }
      if (request.method === "PUT") {
        let value: unknown;
        try {
          value = JSON.parse(body);
        } catch {
          return json(response, 400, {});
        }
        const given = typeof value === "object" && value !== null && Reflect.get(value, "grant");
        if (typeof given !== "string" || !given) return json(response, 400, {});
        grant = given;
        handed++;
        response.writeHead(204).end();
        return;
      }
    }
    // A bot's MCP server (ADR 0133): one tool, `remember`, that echoes which bot ran it.
    const botMcp = /^\/v1\/agents\/([^/]+)\/mcp$/.exec(url.pathname);
    if (request.method === "POST" && botMcp?.[1]) {
      const rpc = JSON.parse(body) as { id: number; method: string; params?: unknown };
      if (rpc.method === "tools/list")
        return json(response, 200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { tools: [{ name: "remember", inputSchema: { type: "object" } }] },
        });
      return json(response, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [{ type: "text", text: `${botMcp[1]} ran ${JSON.stringify(rpc.params)}` }],
          isError: false,
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/conversations")
      return json(response, 201, { id: "c1", received: body });
    if (request.method === "GET" && live?.[1]) {
      const id = live[1];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      send(response, "stored", { seq: Number(url.searchParams.get("after") ?? 0) + 1 });
      const open = streams.get(id) ?? new Set();
      streams.set(id, open.add(response));
      request.socket.once("close", () => open.delete(response));
      return;
    }
    if (request.method === "POST" && messages?.[1]) {
      if (body.length < 4096)
        for (const stream of streams.get(messages[1]) ?? []) send(stream, "delta", { text: body });
      const bytes = Buffer.concat(chunks);
      return json(response, 202, {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const image = /^\/v1\/images\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && image?.[1]) {
      response.writeHead(200, { "content-type": "image/png" });
      return response.end(imageBytes(Number(image[1])));
    }
    if (request.method === "POST" && url.pathname === "/v1/crash") {
      json(response, 202, {});
      setTimeout(() => process.exit(1), 20);
      return;
    }
    json(response, 404, {});
  });
});

/** ace's MCP endpoint as Spade finds it, called with the grant it holds. */
async function reachAce() {
  const home = process.env.SPADE_ACE_HOME;
  if (!home) throw new Error("SPADE_ACE_HOME is not set");
  const endpoint = readFileSync(join(home, "daemon-endpoint"), "utf8").trim();
  const mcpUrl = `${endpoint}/mcp`;
  const headers = {
    authorization: `Bearer ${grant ?? ""}`,
    accept: "application/json, text/event-stream",
    "x-ace-notifications": "stream",
  };
  const ping = await fetch(mcpUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await ping.body?.cancel();
  // The list-changed stream as spade-ace opens it: a 2025-11-25 session, then GET under its id.
  const post = (body: unknown, session?: string) =>
    fetch(mcpUrl, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" } : {}),
      },
      body: JSON.stringify(body),
    });
  const opened = await post({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "spade", version },
    },
  });
  const session = opened.headers.get("mcp-session-id") ?? "";
  await opened.body?.cancel();
  await (
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session)
  ).body?.cancel();
  const stream = await fetch(mcpUrl, {
    method: "GET",
    headers: {
      ...headers,
      accept: "text/event-stream",
      "mcp-session-id": session,
      "mcp-protocol-version": "2025-11-25",
    },
    signal: AbortSignal.timeout(20_000),
  });
  // The first event the stream carries (a tools list change), then it is let go.
  const reader = stream.body?.getReader();
  let text = "";
  while (!/data: .*\n/.test(text)) {
    if (!reader) break;
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader?.cancel();
  const data = /data: (.*)\n/.exec(text)?.[1];
  const event: unknown = data ? JSON.parse(data) : undefined;
  return {
    mcpUrl,
    ping: ping.status,
    stream: {
      status: stream.status,
      method:
        typeof event === "object" && event !== null ? String(Reflect.get(event, "method")) : null,
    },
  };
}

const [host = "127.0.0.1", port = "0"] = listen.split(":");
server.listen(Number(port), host, () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(2);
  writeFileSync(join(dataDir, "token"), token, { mode: 0o600 });
  const info = { address: `127.0.0.1:${address.port}`, pid: process.pid, version, api: 1 };
  writeFileSync(join(dataDir, "server.json.tmp"), JSON.stringify(info));
  renameSync(join(dataDir, "server.json.tmp"), join(dataDir, "server.json"));
});
process.once("SIGTERM", () => {
  for (const open of streams.values()) for (const stream of open) stream.end();
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
