/**
 * A Vite-like dev page through the machine's localhost tunnel (ADR 0194) over a slow link: one
 * dev server in its own process serving an HTML page and a two-level module graph, one real
 * daemon in a temporary home, and one local relay (apps/relay, never the hosted one). The link
 * shaper (@ace/perf-kit/link) sits on the device's leg: in front of the daemon's TLS listener for
 * the direct path, in front of the relay for the relayed one. A loader stands in for the
 * browser: HTTP/1.1, keep-alive, at most six connections to the origin, each connection a
 * tunnel stream, modules fetched as their importers arrive.
 *
 * Reported per path and profile: the tunnel's connect time, first paint (the HTML and its entry
 * script), full load (every module), and streams opened.
 *
 *   bun apps/daemon/bench/machine-tunnel.ts [--profiles=3g-slow,lan] [--modules=300]
 *     [--output=FILE.json]
 *
 * Report only, never a gate. Everything it starts is stopped, and its homes deleted, at the end.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PairingResponse } from "@ace/protocol";
import { startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { linkProfile, startLinkShaper } from "@ace/perf-kit/link";
import {
  openPathTunnel,
  type TunnelPathTarget,
  type TunnelStream,
} from "@ace/client/machine-tunnel";
import { nodeTunnelDialer } from "@ace/client/machine-tunnel/node";
import { accessRequest, redeemPairing } from "../src/client-access.ts";
import { fixture, token } from "../src/socket-test-support.ts";
import { loadIdentity } from "../src/tls-identity.ts";
import { writeMeasurement } from "./output.ts";

const argument = (name: string, fallback: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const profiles = argument("profiles", "3g-slow,lan").split(",").map(linkProfile);
const modules = z.coerce.number().int().min(1).max(2000).parse(argument("modules", "300"));
const output = argument("output", "");
const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** The dev server: `/` imports `/main.js`, which imports the first level, which imports the rest. */
const devServerSource = `
const http = require("node:http");
const total = Number(process.argv[1]);
const first = Math.max(1, Math.round(Math.sqrt(total)));
const pad = "/* " + "x".repeat(1800) + " */\\n";
const children = (i) => { const out = []; for (let n = first + i; n < total; n += first) out.push(n); return out; };
const body = (path) => {
  if (path === "/") return ["text/html", '<!doctype html><script type="module" src="/main.js"></script>'];
  if (path === "/main.js") return ["text/javascript", Array.from({ length: first }, (_, i) => 'import "/m/' + i + '.js";').join("\\n") + pad];
  const m = /^\\/m\\/(\\d+)\\.js$/.exec(path);
  if (!m) return undefined;
  const i = Number(m[1]);
  return ["text/javascript", (i < first ? children(i).map((n) => 'import "/m/' + n + '.js";').join("\\n") : "") + pad];
};
const server = http.createServer((req, res) => {
  const found = body(req.url);
  if (!found) { res.writeHead(404, { "content-length": 0 }); res.end(); return; }
  const bytes = Buffer.from(found[1]);
  res.writeHead(200, { "content-type": found[0], "content-length": bytes.length, "cache-control": "no-store" });
  res.end(bytes);
});
server.keepAliveTimeout = 60000;
server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
`;

/** One keep-alive HTTP/1.1 connection over a tunnel stream. */
function httpConnection(stream: TunnelStream) {
  const reader = stream.readable.getReader();
  let buffer = new Uint8Array(0);
  const more = async () => {
    const { value, done } = await reader.read();
    if (done) throw new Error("Connection ended");
    const joined = new Uint8Array(buffer.length + value.length);
    joined.set(buffer);
    joined.set(value, buffer.length);
    buffer = joined;
  };
  return {
    async get(path: string): Promise<string> {
      await stream.write(
        new TextEncoder().encode(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`),
      );
      let end = -1;
      while ((end = Buffer.from(buffer).indexOf("\r\n\r\n")) < 0) await more();
      const head = new TextDecoder().decode(buffer.subarray(0, end));
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
      while (buffer.length < end + 4 + length) await more();
      const text = new TextDecoder().decode(buffer.subarray(end + 4, end + 4 + length));
      buffer = buffer.subarray(end + 4 + length);
      return text;
    },
    close: () => stream.reset(),
  };
}

/** Loads the page as a browser would: six connections, each module fetched once its importer is. */
async function loadPage(open: () => Promise<TunnelStream>) {
  const started = performance.now();
  const idle: ReturnType<typeof httpConnection>[] = [];
  const all: ReturnType<typeof httpConnection>[] = [];
  const waiting: ((connection: ReturnType<typeof httpConnection>) => void)[] = [];
  let streams = 0;
  const lease = async () => {
    const free = idle.pop();
    if (free) return free;
    // Counted before the open resolves, so concurrent requests never open a seventh.
    if (streams < 6) {
      streams++;
      const connection = httpConnection(await open());
      all.push(connection);
      return connection;
    }
    return new Promise<ReturnType<typeof httpConnection>>((resolve) => waiting.push(resolve));
  };
  const release = (connection: ReturnType<typeof httpConnection>) => {
    const next = waiting.shift();
    if (next) next(connection);
    else idle.push(connection);
  };
  const fetched = new Set<string>();
  const get = async (path: string): Promise<string> => {
    const connection = await lease();
    try {
      return await connection.get(path);
    } finally {
      release(connection);
    }
  };
  const load = async (path: string): Promise<void> => {
    if (fetched.has(path)) return;
    fetched.add(path);
    const source = await get(path);
    await Promise.all(
      [...source.matchAll(/import "([^"]+)"/g)].map((match) => load(match[1] ?? "")),
    );
  };
  const html = await get("/");
  const entry = /src="([^"]+)"/.exec(html)?.[1] ?? "/main.js";
  const entrySource = await get(entry);
  fetched.add(entry);
  const firstPaintMs = performance.now() - started;
  await Promise.all(
    [...entrySource.matchAll(/import "([^"]+)"/g)].map((match) => load(match[1] ?? "")),
  );
  const fullLoadMs = performance.now() - started;
  for (const connection of all) connection.close();
  return { firstPaintMs, fullLoadMs, requests: fetched.size + 1, streams };
}

/** A plain TCP connection as a stream, for the baseline: the browser on the machine's network. */
async function plainStream(host: string, port: number): Promise<TunnelStream> {
  const socket = connect({ host, port, allowHalfOpen: true });
  await once(socket, "connect");
  const closed = once(socket, "close").then(() => undefined);
  return {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        socket.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        socket.on("end", () => controller.close());
        socket.on("error", (error) => controller.error(error));
      },
    }),
    write: (chunk) =>
      new Promise((resolve, reject) =>
        socket.write(chunk, (error) => (error ? reject(error) : resolve())),
      ),
    end: () => socket.end(),
    reset: () => socket.destroy(),
    closed,
  };
}

const cleanups: (() => unknown)[] = [];
const results: Record<string, unknown>[] = [];
try {
  const homes = mkdtempSync(join(tmpdir(), "ace-tunnel-bench-"));
  cleanups.push(() => rmSync(homes, { recursive: true, force: true }));
  const dev = spawn(process.execPath, ["-e", devServerSource, String(modules)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(() => dev.kill());
  const [line] = (await once(dev.stdout, "data")) as [Buffer];
  const devPort = Number(line.toString().trim());
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  const identity = loadIdentity(homes);
  const f = await fixture({
    relay: { url: relay.url, keys: keyPair() },
    remote: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, identity },
  });
  cleanups.push(() => f.close());
  const remoteUrl = f.server.remoteUrl;
  const hostKey = f.server.relayHostId;
  if (!remoteUrl || !hostKey) throw new Error("The daemon has no remote listener or relay");
  const pairing = PairingResponse.parse(
    await accessRequest(f.server.httpUrl, "/v1/pairings", {
      method: "POST",
      token,
      body: { scopes: ["read", "operate"] },
    }),
  );
  const credential = await redeemPairing(pairing.url, "Bench phone");
  const machine = {
    expectedHostId: "host",
    deviceId: credential.device.id,
    token: async () => credential.token,
  };
  const dialer = nodeTunnelDialer();
  for (const profile of profiles) {
    // The floor: the same loader straight to the dev server over the same link, no tunnel.
    const plain = await startLinkShaper({
      target: { host: "127.0.0.1", port: devPort },
      profile,
      seed: 7,
    });
    const baseline = await loadPage(() => plainStream(plain.host, plain.port));
    await plain.close();
    const floor = {
      path: "no tunnel",
      profile: profile.name,
      connectMs: 0,
      firstPaintMs: Math.round(baseline.firstPaintMs),
      fullLoadMs: Math.round(baseline.fullLoadMs),
      requests: baseline.requests,
      streams: baseline.streams,
    };
    results.push(floor);
    console.log(JSON.stringify(floor));
    for (const kind of ["direct", "relay"] as const) {
      const target = new URL(kind === "direct" ? remoteUrl : relay.url);
      const shaper = await startLinkShaper({
        target: { host: target.hostname, port: Number(target.port) },
        profile,
        seed: 7,
      });
      const path: TunnelPathTarget =
        kind === "direct"
          ? {
              kind,
              key: kind,
              url: `wss://${shaper.address}/`,
              fingerprint: identity.fingerprint,
            }
          : { kind, key: kind, url: `${target.protocol}//${shaper.address}`, hostKey };
      const connectStarted = performance.now();
      const tunnel = openPathTunnel({
        machine,
        path: { get: () => path, subscribe: () => () => {} },
        dialer,
        schedule,
      });
      // The tunnel is up once the machine has sent its ports, which follows the welcome.
      await new Promise<void>((resolve) => {
        const stop = tunnel.ports.subscribe(() => {
          stop();
          resolve();
        });
      });
      const connectMs = performance.now() - connectStarted;
      const page = await loadPage(() => tunnel.open(devPort));
      tunnel.close();
      await shaper.close();
      const result = {
        path: kind,
        profile: profile.name,
        connectMs: Math.round(connectMs),
        firstPaintMs: Math.round(page.firstPaintMs),
        fullLoadMs: Math.round(page.fullLoadMs),
        requests: page.requests,
        streams: page.streams,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const measurement = {
    bench: "machine-tunnel",
    modules,
    machine: { cpus: cpus().length, load: loadavg().map((n) => Math.round(n * 10) / 10) },
    results,
  };
  if (output) await writeMeasurement(output, `${JSON.stringify(measurement, null, 2)}\n`);
} finally {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
}
