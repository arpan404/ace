// SPDX-License-Identifier: Apache-2.0
/**
 * Peer identity and per-connection state through the native hop (T1b.2). Nothing drove these
 * through the daemon before: the Tailscale listener's outside MCP chain, the webhook route, the
 * per-caller budget and the trust marker all read what the connection knew, and through the hop
 * that is the reserved headers Rust adds and strips.
 *
 * A static remote listener carries the requests (its port is the public one), while a runtime
 * Tailscale listener supplies the reach facts an outside client is admitted by. Both legs:
 * `ACE_TRANSPORT` off serves the static listener from `node:https`, on from Rust.
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsService } from "@ace/settings";
import { transportParts } from "@ace/provider-kit/native-switches";
import { transportAddon } from "@ace/provider-kit/native-transport";
import { readConfig } from "./config.ts";
import { externalMcp, type ExternalMcp } from "./external-mcp/server.ts";
import type { AutomationWebhookService } from "./automation-webhooks.ts";
import { Resources } from "./services/resources.ts";
import type { ServiceContext } from "./services/types.ts";
import { fixture } from "./socket-test-support.ts";
import { startNativeRemote } from "./native-remote.ts";
import type { NativeUpgrade } from "./native-upgrade.ts";
import { Store } from "./store.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { loadIdentity } from "./tls-identity.ts";

const tailnet = "studio.tail1234.ts.net";
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
  const identity = loadIdentity(tlsFixtureHome());
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
      identity: loadIdentity(tlsFixtureHome()),
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
