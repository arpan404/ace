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
 * - `POST /v1/conversations`: `201`, echoing the body it received.
 * - `GET /v1/conversations/{id}/live?after=N`: server-sent events, `stored` with seq N + 1 first.
 * - `POST /v1/conversations/{id}/messages`: `202` with the body's size and SHA-256, and a `delta`
 *   with a small body on open streams.
 * - `GET /v1/images/{n}`: `n` bytes of `image/png` (`imageBytes`).
 * - `POST /v1/crash`: `202`, then exits with code 1.
 */
import { createHash, randomBytes } from "node:crypto";
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
  if (request.method === "GET" && url.pathname === "/health")
    return json(response, 200, { ok: true, version, api: 1 });
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
