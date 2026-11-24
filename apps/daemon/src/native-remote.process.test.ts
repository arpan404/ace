// SPDX-License-Identifier: Apache-2.0
/**
 * Peer identity and per-connection state through the native hop (T1b.2), and the shell's
 * limits and per-message deflate (T1b.3b). Nothing drove identity through the daemon before:
 * the Tailscale listener's outside MCP chain, the webhook route, the per-caller budget and the
 * trust marker all read what the connection knew, and through the hop that is the reserved
 * headers Rust adds and strips.
 *
 * A static remote listener carries the requests (its port is the public one), while a runtime
 * Tailscale listener supplies the reach facts an outside client is admitted by. Both legs:
 * `ACE_TRANSPORT` off serves the static listener from `node:https`, on from Rust.
 *
 * The same listener hands its timers to N-API: `headMs` and `trustedKeepAliveMs` are optional
 * in `ConnectionLimits`, and JavaScript says so with `null`. And its sockets negotiate
 * per-message deflate: a `ws` client's `server_max_window_bits=8` and `client_max_window_bits=8`
 * offers each get the answer echoing `=8` with both no-context-takeover parameters, and a
 * 13 KiB message goes each way intact.
 */
import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { SettingsService } from "@ace/settings";
import { transportParts } from "@ace/provider-kit/native-switches";
import { transportAddon } from "@ace/provider-kit/native-transport";
import { accessRequest } from "./client-access.ts";
import { readConfig } from "./config.ts";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { externalMcp, type ExternalMcp } from "./external-mcp/server.ts";
import type { AutomationWebhookService } from "./automation-webhooks.ts";
import { startNativeRemote } from "./native-remote.ts";
import { nativeSniListeners } from "./native-sni-listener.ts";
import type { NativeUpgrade } from "./native-upgrade.ts";
import { NativeSocket } from "./native-socket.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { fixture, token } from "./socket-test-support.ts";
import { Store } from "./store.ts";
import { trustedCertificate } from "./tailscale-certificate.ts";
import { loadIdentity, publicKeyFingerprint } from "./tls-identity.ts";

const tailnet = "studio.tail1234.ts.net";
/** The daemon's own TLS identity, the static listener's and the runtime one's. */
const identity = loadIdentity(tlsFixtureHome());
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A self-signed certificate for `name`, as `tailscale cert` would print one. */
function certificate(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ace-native-remote-cert-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=DNS:${name}`,
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  return `${readFileSync(join(directory, "cert.pem"), "utf8")}${readFileSync(join(directory, "key.pem"), "utf8")}`;
}

/** What a Tailscale listener reaches, and the trust its certificate buys. */
const network = (pem: string) => ({
  identity: () => loadIdentity(tlsFixtureHome()),
  interfaces: () => ({}),
  status: async () =>
    JSON.stringify({
      BackendState: "Running",
      TailscaleIPs: ["127.0.0.1"],
      Self: { DNSName: `${tailnet}.` },
      CurrentTailnet: { MagicDNSEnabled: true },
    }),
  certificate: async (name: string) => {
    if (name !== tailnet) throw new Error(`unexpected certificate request for ${name}`);
    return pem;
  },
});

/**
 * The daemon's outside MCP endpoint, built over the same settings, so its Tailscale handler sees
 * the runtime listener's reach facts. The webhook service is this file's own: the route is what
 * is under test, not the automation store.
 */
async function outside(
  home: string,
  settings: SettingsService,
): Promise<{
  server: ExternalMcp;
  onListen: ServiceContext["onListen"];
}> {
  const store = new Store(join(home, "outside.sqlite"));
  cleanups.push(() => store.close());
  const resources = new Resources();
  cleanups.push(() => resources.close());
  const onListen: ServiceContext["onListen"] = [];
  const webhooks = {
    enabled: (via: string) => via === "tailscale",
    serve: async () => new Response(null, { status: 405 }),
  } as unknown as AutomationWebhookService;
  const context: ServiceContext = {
    signal: new AbortController().signal,
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    options: {},
    store,
    now: Date.now,
    id: randomUUID,
    log: { log() {} } as unknown as ServiceContext["log"],
    resources,
    services: { settings, automationWebhooks: webhooks },
    onListen,
  };
  const server = await externalMcp(context);
  cleanups.push(() => server.close());
  return { server, onListen };
}

/** A daemon with Tailscale reach facts behind its public listener (static on the native leg). */
async function tailnetDaemon() {
  const home = mkdtempSync(join(tmpdir(), "ace-native-remote-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const settings = new SettingsService({ dataDir: home });
  cleanups.push(() => settings.close());
  await settings.set("remote.enabled", true, { kind: "global" });
  await settings.set("remote.transport", "tailscale", { kind: "global" });
  await settings.set("remote.tailscaleMcp", true, { kind: "global" });
  const mcp = await outside(home, settings);
  const remoteConfig = readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" });
  const f = await fixture({
    settings,
    remoteConfig,
    network: network(certificate(tailnet)),
    // Off, the runtime listener is the `node:tls` one, whose sockets are `TLSSocket`s. On, the
    // public port is the static native listener, so the hop (and its headers) is in the path.
    ...(transportParts().has("remote")
      ? { remote: { host: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, identity } }
      : {}),
    externalMcp: mcp.server,
  });
  cleanups.push(() => f.close());
  for (const listen of mcp.onListen) await listen(f.server);
  // The runtime listener starts in the background; the reach facts are what admit a tailnet
  // request, and they exist only once its certificate is served.
  await f.server.remoteStarted.direct;
  let reachHost = "";
  await expect
    .poll(
      () => {
        const facts = f.server.outsideReach().tailscale();
        if ("problem" in facts) return facts.problem;
        reachHost = new URL(`https://${facts.name}:${facts.port}`).host;
        return "on";
      },
      { timeout: 15_000 },
    )
    .toBe("on");
  const remote = f.server.remoteUrl;
  if (!remote) throw new Error("No remote listener");
  const port = Number(new URL(remote.replace("wss:", "https:")).port);
  return { f, settings, port, host: reachHost };
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

/** One HTTPS request to the listener, naming `servername` and `host` where the case needs them. */
function ask(
  port: number,
  path: string,
  options: {
    method?: string;
    servername?: string;
    host?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        servername: options.servername,
        headers: { ...(options.host ? { host: options.host } : {}), ...options.headers },
        rejectUnauthorized: false,
        agent: false,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

it("outside MCP at the ts.net name is served there, and another name falls to the daemon's routes", async () => {
  const { port, host } = await tailnetDaemon();
  const outsideMcp = await ask(port, "/mcp", { servername: tailnet, host });
  expect(outsideMcp.status).toBe(401);
  expect(outsideMcp.headers["www-authenticate"]).toBeDefined();

  const elsewhere = await ask(port, "/mcp", {
    servername: "other.tail1234.ts.net",
    host: "other.tail1234.ts.net",
  });
  expect(elsewhere.status).not.toBe(401);
  expect(elsewhere.headers["www-authenticate"]).toBeUndefined();
});

it("a webhook path at the ts.net name reaches the webhook, and at the 100.x address it does not", async () => {
  const { settings, port, host } = await tailnetDaemon();
  await settings.set("remote.tailscaleWebhooks", true, { kind: "global" });
  // The webhook service answers a GET on its path with its own 405; the daemon chain answers
  // something else (403 without a device, or 404).
  const atName = await ask(port, "/hooks/none", { servername: tailnet, host });
  expect(atName.status).toBe(405);
  const atAddress = await ask(port, "/hooks/none", { host: "127.0.0.1" });
  expect(atAddress.status).not.toBe(405);
});

it("two callers claiming different peer headers share one per-caller budget", async () => {
  const { port, host } = await tailnetDaemon();
  // The register limit is ten a minute for one caller; a client cannot name itself a new one.
  const statuses: number[] = [];
  for (let index = 0; index < 11; index++)
    statuses.push(
      (
        await ask(port, "/register", {
          method: "POST",
          servername: tailnet,
          host,
          headers: { "x-ace-outside-peer": `10.0.0.${index + 1}` },
        })
      ).status,
    );
  expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true);
  expect(statuses[10]).toBe(429);
});

it("a trust marker never crosses the hop in either direction", async () => {
  const { f, port, host } = await tailnetDaemon();
  // A client's marker does not make its connection trusted: the answer still says five seconds.
  const device = f.store.devices.create("Phone", ["read", "operate", "admin"], 1000);
  const claimed = await ask(port, "/v1/status", {
    servername: tailnet,
    host,
    headers: { authorization: `Bearer ${device.token}`, "X-Ace-Hop-Trust": "1" },
  });
  expect(claimed.status).toBe(200);
  expect(claimed.headers["keep-alive"]).toBe("timeout=5");

  // An authenticated handler marks the connection trusted with the marker; the client never
  // reads the marker itself.
  const trusted = await ask(port, "/v1/transfers", {
    method: "POST",
    servername: tailnet,
    host,
    headers: { authorization: `Bearer ${device.token}` },
  });
  expect(trusted.status).toBe(503);
  // The marker is the hop's: the client never reads it, on either leg. (The static listener has
  // no trusted window, so its answer keeps the ordinary timeout; T1b.4 proves that one.)
  expect(trusted.headers["x-ace-hop-trust"]).toBeUndefined();
});

/** A GET through TLS, its status the answer. */
function plainStatus(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: "127.0.0.1", port, path: "/", rejectUnauthorized: false },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

const noopUpgrades: NativeUpgrade = {
  admit: async () => ({ decision: "accept", reservation: 0 }),
  release: () => {},
  opened: () => {},
};

it.runIf(transportParts().has("remote"))(
  "the native remote shell binds and serves when the optional limits are null",
  async () => {
    const target = createServer((_request, response) => response.end("ok"));
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("No target port");
    const errors: string[] = [];
    const listener = await startNativeRemote({
      host: "127.0.0.1",
      port: 0,
      targetPort: address.port,
      identity,
      hopSecret: transportAddon().NativeLoopback.generateSecret(),
      limits: {
        handshakeMs: 5_000,
        firstHeadMs: 5_000,
        headMs: null,
        keepAliveMs: 5_000,
        trustedKeepAliveMs: null,
      },
      upgrade: noopUpgrades,
      holdPort: () => () => {},
      log: (error) => errors.push(error.message),
    });
    try {
      expect(await plainStatus(listener.port())).toBe(200);
    } finally {
      await listener.close(0);
      target.close();
      await once(target, "close");
    }
    expect(errors).toEqual([]);
  },
  30_000,
);

/**
 * A listener whose opened sockets echo every message back, so a `ws` client can prove a message
 * crosses compressed and inflated intact. Each socket is tracked so the listener's close waits for
 * it, as `native-upgrade.ts` does for the daemon's own.
 */
async function echoListener() {
  const target = createServer((_request, response) => response.end("ok"));
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const address = target.address();
  if (address === null || typeof address === "string") throw new Error("No target port");
  const sockets = new Set<NativeSocket>();
  const upgrade: NativeUpgrade = {
    admit: async () => ({ decision: "accept", reservation: 0 }),
    release: () => {},
    opened: (handle) => {
      const socket = new NativeSocket(handle);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    },
  };
  const listener = await startNativeRemote({
    host: "127.0.0.1",
    port: 0,
    targetPort: address.port,
    identity,
    hopSecret: transportAddon().NativeLoopback.generateSecret(),
    limits: {
      handshakeMs: 5_000,
      firstHeadMs: 5_000,
      headMs: null,
      keepAliveMs: 5_000,
      trustedKeepAliveMs: null,
    },
    upgrade,
    holdPort: () => () => {},
    log: () => {},
  });
  return {
    port: listener.port(),
    async close() {
      for (const socket of sockets) socket.close();
      await listener.close(5_000);
      target.close();
      await once(target, "close");
    },
  };
}

/** The `101`'s extension answer, from the response the client's upgrade reported. */
async function upgradeOffer(
  port: number,
  options: { serverMaxWindowBits: number } | { clientMaxWindowBits: number },
) {
  const socket = new WebSocket(`wss://127.0.0.1:${port}`, {
    rejectUnauthorized: false,
    perMessageDeflate: options,
  });
  const answered = once(socket, "upgrade") as Promise<[{ headers: Record<string, string> }]>;
  const closed = once(socket, "close");
  await once(socket, "open");
  const [response] = await answered;
  return {
    answer: response.headers["sec-websocket-extensions"],
    socket,
    async finish() {
      socket.close();
      await closed;
    },
  };
}

describe.runIf(transportParts().has("remote"))("permessage-deflate on the native listener", () => {
  it("answers both window-bits offers with =8 and both no-context-takeover parameters", async () => {
    const listener = await echoListener();
    try {
      const serverBits = await upgradeOffer(listener.port, { serverMaxWindowBits: 8 });
      expect(serverBits.answer).toBe(
        "permessage-deflate; server_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
      );
      await serverBits.finish();

      const clientBits = await upgradeOffer(listener.port, { clientMaxWindowBits: 8 });
      expect(clientBits.answer).toBe(
        "permessage-deflate; client_max_window_bits=8; server_no_context_takeover; client_no_context_takeover",
      );
      await clientBits.finish();
    } finally {
      await listener.close();
    }
  }, 30_000);

  it("carries a 13 KiB message both ways intact on each window-bits offer", async () => {
    const listener = await echoListener();
    const text = Array.from(
      { length: 400 },
      (_, line) => `  const value${line % 50} = await readConfig(path, { strict: true });`,
    ).join("\n");
    expect(Buffer.byteLength(text)).toBeGreaterThan(12 * 1024);
    try {
      for (const options of [{ serverMaxWindowBits: 8 }, { clientMaxWindowBits: 8 }]) {
        const opened = await upgradeOffer(listener.port, options);
        const echoed = once(opened.socket, "message");
        opened.socket.send(text);
        const [answer] = (await echoed) as [Buffer];
        expect(answer.toString()).toBe(text);
        await opened.finish();
      }
    } finally {
      await listener.close();
    }
  }, 30_000);
});

/** The leaf's PEM out of what `certificate()` printed: the chain, then the key. */
function leafOf(pem: string): string {
  const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem);
  if (!match) throw new Error("No certificate");
  return match[0];
}

/** The key a TLS client is shown when it asks for `servername`. */
async function presented(port: number, servername?: string): Promise<string> {
  const socket = connectTls({
    host: "127.0.0.1",
    port,
    rejectUnauthorized: false,
    ...(servername ? { servername } : {}),
  });
  await once(socket, "secureConnect");
  const raw = socket.getPeerCertificate().raw;
  socket.destroy();
  return publicKeyFingerprint(raw);
}

/** A run-time listener over its own loopback hop target, with the clock and timers it is handed. */
function runtimeListener(clock: {
  now(): number;
  delay(callback: () => void, ms: number): () => void;
}) {
  return nativeSniListeners({
    secret: transportAddon().NativeLoopback.generateSecret(),
    upgrades: noopUpgrades,
    delay: clock.delay,
    now: clock.now,
    tunnel: { hold: () => () => {} },
  }).make({
    tls: identity,
    requests: (_request, response) => response.writeHead(204).end(),
    delay: systemDeliveryRuntime.delay,
    log: () => {},
  });
}

it.runIf(transportParts().has("remote"))(
  "a Tailscale certificate that expires while renewals fail leaves Rust at its expiry",
  async () => {
    const pem = certificate(tailnet);
    const expires = new X509Certificate(leafOf(pem)).validToDate.getTime();
    let now = Date.now();
    let reachable = true;
    const trusted = trustedCertificate({
      name: tailnet,
      fetch: async () => {
        if (!reachable) throw new Error("tailscaled is unreachable");
        return pem;
      },
      now: () => now,
      delay: () => () => {},
    });
    cleanups.push(() => trusted.stop());
    const timers: (() => void)[] = [];
    const listener = runtimeListener({
      now: () => now,
      delay: (callback) => {
        timers.push(callback);
        return () => {};
      },
    });
    cleanups.push(() => listener.close());
    // A certificate fetched before the bind reaches Rust at the bind, not at its next renewal.
    await trusted.ready;
    listener.trust?.(trusted);
    const port = await listener.listen("127.0.0.1", 0);
    expect(await presented(port, tailnet)).toBe(publicKeyFingerprint(leafOf(pem)));
    expect(await presented(port, "studio.local")).toBe(identity.fingerprint);

    // Renewals keep failing past the certificate's expiry: Rust serves the pin there.
    reachable = false;
    now = expires;
    timers.pop()?.();
    expect(await presented(port, tailnet)).toBe(identity.fingerprint);
  },
  30_000,
);

it.runIf(transportParts().has("remote"))(
  "an upgrade racing a settings retire never stays open",
  async () => {
    const { f, port } = await tailnetDaemon();
    const upgrade = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    upgrade.on("error", () => {});
    cleanups.push(() => upgrade.terminate());
    // Retire without waiting for the `101`: whichever side of the registration the upgrade lands
    // on, the socket ends closed (recorded difference 7).
    const control = await f.connect();
    await control.next();
    control.send({
      type: "settings.set",
      requestId: "retire",
      key: "remote.enabled",
      value: false,
      layer: { kind: "global" },
    });
    expect(await control.next()).toMatchObject({ ok: true });
    await expect.poll(() => upgrade.readyState, { timeout: 10_000 }).toBe(WebSocket.CLOSED);
    expect(f.server.remoteUrl).toBeUndefined();
  },
  30_000,
);

const LanStatus = z.object({
  remoteAccess: z.object({
    networks: z.record(z.string(), z.object({ state: z.string(), error: z.string().optional() })),
  }),
});

it("a LAN port taken at start is reported, and once freed the listener serves on the next retry", async () => {
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, "0.0.0.0", resolve));
  const address = taken.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const home = mkdtempSync(join(tmpdir(), "ace-native-remote-lan-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const settings = new SettingsService({ dataDir: home });
  cleanups.push(() => settings.close());
  await settings.set("remote.enabled", true, { kind: "global" });
  await settings.set("remote.transport", "lan", { kind: "global" });
  const f = await fixture({
    settings,
    network: network(certificate(tailnet)),
    remoteConfig: readConfig({
      ACE_HOME: home,
      ACE_PORT: "0",
      ACE_ADVERTISE_HOST: "127.0.0.1",
      ACE_REMOTE_PORT: String(address.port),
      ACE_LOG_LEVEL: "silent",
    }),
  });
  cleanups.push(() => f.close());
  const networks = async () =>
    LanStatus.parse(await accessRequest(f.server.httpUrl, "/v1/status", { token })).remoteAccess
      .networks;
  await f.server.remoteStarted.direct;
  expect(await networks()).toMatchObject({
    lan: { state: "failed", error: expect.stringContaining(`port ${address.port}`) },
  });
  expect(f.server.remoteUrl).toBeUndefined();

  // Freed, the runtime's own retry opens it, whichever listener backend serves it.
  await new Promise<void>((resolve) => taken.close(() => resolve()));
  await expect.poll(async () => (await networks()).lan?.state, { timeout: 20_000 }).toBe("on");
  expect(f.server.remoteUrl).toContain(`:${address.port}`);
}, 30_000);
