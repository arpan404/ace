import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import { CommandId, DeviceId } from "@ace/protocol";
import { startRelay } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { SettingsService } from "@ace/settings";
import {
  openPathTunnel,
  type MachineTunnel,
  type TunnelMachine,
  type TunnelPathTarget,
  type TunnelStream,
} from "@ace/client/machine-tunnel";
import { nodeTunnelDialer } from "@ace/client/machine-tunnel/node";
import { cleanups, identity, setup } from "../remote-test-support.ts";
import { loadIdentity } from "../tls-identity.ts";

/*
 * A real daemon's tunnel (ADR 0194) on both kinds of path a device reaches it by: its TLS
 * listener, with the pinned certificate and a one-use ticket, and a local relay, with the paired
 * token inside the encrypted stream. Real edge: the daemon's listeners, the relay, and the
 * loopback servers it dials.
 */

const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * A TCP echo server in a process of its own, as a dev server is: every port the daemon's own
 * process holds is ace's, which the tunnel refuses.
 */
async function echoServer() {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("node:net");
       const server = net.createServer({ allowHalfOpen: true }, (s) => { s.on("error", () => {}); s.pipe(s); });
       server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(() => {
    child.kill();
  });
  const [line] = (await once(child.stdout, "data")) as [Buffer];
  return Number(line.toString().trim());
}

async function roundTrip(stream: TunnelStream, text: string): Promise<string> {
  const reader = stream.readable.getReader();
  await stream.write(new TextEncoder().encode(text));
  stream.end();
  let received = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return received;
    received += new TextDecoder().decode(value);
  }
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "opened",
    (error: unknown) => (error as { code?: string }).code,
  );

const dialer = nodeTunnelDialer();

async function daemon(scopes = ["read", "operate"]) {
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  let settings: SettingsService | undefined;
  const f = await setup({ relay: { url: relay.url, keys: keyPair() } }, (_store, home) => {
    settings = new SettingsService({ dataDir: home });
    return { settings };
  });
  if (!settings) throw new Error("Settings missing");
  const hostKey = f.server.relayHostId;
  if (!hostKey) throw new Error("Relay host missing");
  const credential = await f.pair(scopes);
  // The welcome names the daemon (`host` in the fixture); the relay pins its key.
  const machine: TunnelMachine = {
    expectedHostId: "host",
    deviceId: credential.device.id,
    token: async () => credential.token,
  };
  const direct: TunnelPathTarget = {
    kind: "direct",
    key: "lan",
    url: f.server.remoteUrl,
    fingerprint: identity.fingerprint,
  };
  const relayed: TunnelPathTarget = { kind: "relay", key: "relay", url: relay.url, hostKey };
  const open = (target: TunnelPathTarget, as: TunnelMachine = machine): MachineTunnel => {
    const tunnel = openPathTunnel({
      machine: as,
      path: { get: () => target, subscribe: () => () => {} },
      dialer,
      schedule,
    });
    cleanups.push(() => tunnel.close());
    return tunnel;
  };
  const daemonPorts = [f.server.remoteUrl, f.server.httpUrl].map((url) =>
    Number(new URL(url).port),
  );
  return { f, settings, machine, credential, direct, relayed, open, daemonPorts };
}

test("an operate device reaches a loopback server through the TLS listener and the relay", async () => {
  const port = await echoServer();
  const { direct, relayed, open, daemonPorts } = await daemon();
  for (const path of [direct, relayed]) {
    const tunnel = open(path);
    expect(await roundTrip(await tunnel.open(port), `over ${path.key}`)).toBe(`over ${path.key}`);
    // The machine's listening ports reach the device, without the daemon's own.
    await expect.poll(() => tunnel.ports.get().includes(port), { timeout: 10_000 }).toBe(true);
    for (const own of daemonPorts) expect(tunnel.ports.get()).not.toContain(own);
    // The daemon's listeners are never dialed: loopback is what they trust.
    for (const own of daemonPorts)
      expect(await refusal(tunnel.open(own))).toBe("tunnel_port_refused");
  }
}, 30_000);

test("a read-only device is refused on every path", async () => {
  const port = await echoServer();
  const { direct, relayed, open } = await daemon(["read"]);
  for (const path of [direct, relayed])
    expect(await refusal(open(path).open(port))).toBe("tunnel_forbidden");
}, 30_000);

test("turning remote.machineLocalhost off ends open streams on every path", async () => {
  const port = await echoServer();
  const { direct, relayed, settings, open } = await daemon();
  const streams = await Promise.all([direct, relayed].map((path) => open(path).open(port)));
  await settings.set("remote.machineLocalhost", false, { kind: "global" });
  await Promise.all(streams.map((stream) => stream.closed));
  expect(await refusal(open(direct).open(port))).toBe("tunnel_off");
}, 30_000);

/**
 * A TLS listener with a certificate of its own, counting what reaches it: TCP connections at a
 * plain front that pipes to it, and HTTP requests and upgrades at the listener itself.
 */
async function impostor() {
  const own = loadIdentity(mkdtempSync(join(tmpdir(), "ace-impostor-")));
  const seen = { connections: 0, requests: 0, upgrades: 0 };
  const server = createHttpsServer({ key: own.key, cert: own.cert }, (_request, response) => {
    seen.requests++;
    response.end("{}");
  });
  server.on("upgrade", (_request, socket) => {
    seen.upgrades++;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const inner = server.address();
  if (!inner || typeof inner === "string") throw new Error("No impostor address");
  const front = createTcpServer((socket) => {
    seen.connections++;
    const upstream = connectTcp(inner.port, "127.0.0.1");
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  front.listen(0, "127.0.0.1");
  await once(front, "listening");
  cleanups.push(() => new Promise<void>((resolve) => front.close(() => resolve())));
  const address = front.address();
  if (!address || typeof address === "string") throw new Error("No impostor address");
  return { url: `wss://127.0.0.1:${address.port}/`, seen };
}

test("a direct path whose listener isn't the pinned one gets no ticket request and no hello", async () => {
  const port = await echoServer();
  const { direct, open } = await daemon();
  const other = await impostor();
  // The daemon's pin, at an address another certificate answers on.
  expect(await refusal(open({ ...direct, url: other.url }).open(port))).toBe("offline");
  // The dialer reached it, and the handshake failed before a byte of HTTP: no ticket exchange
  // (an HTTPS request) and no socket (an upgrade), so the token and any hello stayed home.
  expect(other.seen.connections).toBeGreaterThan(0);
  expect(other.seen.requests).toBe(0);
  expect(other.seen.upgrades).toBe(0);
});

test("a direct path with another daemon's id, or a relay with another's key, is never used", async () => {
  const port = await echoServer();
  const { machine, direct, relayed, open } = await daemon();
  // A welcome naming another daemon is refused on either kind of path.
  for (const path of [direct, relayed])
    expect(await refusal(open(path, { ...machine, expectedHostId: "elsewhere" }).open(port))).toBe(
      "offline",
    );
}, 30_000);

test("two megabytes cross each path whole, many frames to a socket read", async () => {
  const port = await echoServer();
  const { direct, relayed, open } = await daemon();
  const text = "0123456789abcdef".repeat(128 * 1024);
  for (const path of [direct, relayed])
    expect(await roundTrip(await open(path).open(port), text)).toBe(text);
}, 30_000);

test("a tunnel socket's JSON reaches no service: only its pings are answered", async () => {
  const { f, machine, credential } = await daemon();
  const { ticket } = await f.ticket(credential.token);
  const received: { type: string; requestId?: string }[] = [];
  const socket = new WebSocket(f.server.httpUrl.replace(/^http/, "ws"));
  cleanups.push(() => {
    socket.terminate();
  });
  socket.on("message", (data, binary) => {
    if (!binary) received.push(JSON.parse(data.toString()) as { type: string });
  });
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(machine.deviceId),
      ticket,
      channel: "tunnel",
    }),
  );
  await expect.poll(() => received.some((message) => message.type === "welcome")).toBe(true);
  // A read the main socket answers, then a ping.
  const status = {
    type: "command.status",
    requestId: "status-1",
    commandIds: [CommandId.parse(randomUUID())],
  };
  socket.send(JSON.stringify(status));
  socket.send(JSON.stringify({ type: "ping" }));
  await expect.poll(() => received.some((message) => message.type === "pong")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(received.filter((message) => message.requestId !== undefined)).toEqual([]);
  expect(
    received.filter((message) => !["welcome", "pong", "tunnel.ports"].includes(message.type)),
  ).toEqual([]);
  // The same read on the device's main socket is answered: it was a real request.
  const main = await f.connectTicket(machine.deviceId, (await f.ticket(credential.token)).ticket);
  for (;;) if ((await main.next()).type === "welcome") break;
  main.socket.send(JSON.stringify(status));
  for (;;) {
    const message = await main.next();
    if (message.type === "command.status") break;
  }
}, 30_000);
