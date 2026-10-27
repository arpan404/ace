import { FilesService } from "@ace/files";
import { startRelay, connectClientViaRelay } from "@ace/relay";
import { fingerprint } from "@ace/secure-channel";
import { loadOrCreateHostKeys } from "@ace/secure-channel/node";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, test } from "vitest";
import { SettingsService } from "@ace/settings";
import { DeviceCredential, PairingResponse, SocketTicket, DeviceId } from "@ace/protocol";
import { fixture, Client, token } from "./socket-test-support.ts";
import { readConfig } from "./config.ts";
import { loadIdentity } from "./tls-identity.ts";
import { tlsFixtureHome } from "./process-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { addressCheckMs } from "./remote-runtime.ts";

async function runtime(
  overrides: {
    listen?: "local" | "lan";
    enabled?: boolean;
    unavailable?: boolean;
    transport?: "tailscale" | "relay";
    relayUrl?: string;
    runtime?: import("./server-options.ts").ServerOptions["runtime"];
    /** Reads of `remote.hostedPairingLink` wait for this; `onHold` runs as each one starts. */
    holdPairingLinkSetting?: { until: Promise<void>; onHold(): void };
    /** This machine's Tailscale addresses, read on each status; undefined: Tailscale fails. */
    tailnet?: { ips: string[] | undefined };
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "ace-remote-runtime-"));
  const settings = new SettingsService({ dataDir: home });
  const hold = overrides.holdPairingLinkSetting;
  if (hold) {
    const read = settings.get.bind(settings);
    settings.get = (async (...args: Parameters<typeof read>) => {
      if (args[0] === "remote.hostedPairingLink") {
        hold.onHold();
        await hold.until;
      }
      return read(...args);
    }) as typeof settings.get;
  }
  const workspace = join(home, "repository");
  await mkdir(workspace);
  let ids = 0;
  let now = 1000;
  const files = await FilesService.create({
    workspace,
    dataDir: home,
    now: () => now,
    id: () => `file-${++ids}`,
    authorize: () => true,
  });
  if (overrides.enabled) await settings.set("remote.enabled", true, { kind: "global" });
  if (overrides.transport)
    await settings.set("remote.transport", overrides.transport, { kind: "global" });
  if (overrides.relayUrl)
    await settings.set("remote.relayUrl", overrides.relayUrl, { kind: "global" });
  let networkAvailable = !overrides.unavailable;
  const logs: unknown[] = [];
  const webRoot = join(home, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), '<main id="root">Pair this device</main>');
  const config = readConfig({
    ACE_HOME: home,
    ACE_PORT: "0",
    ACE_ADVERTISE_HOST: "127.0.0.1",
    ...(overrides.listen ? { ACE_LISTEN: overrides.listen } : {}),
  });
  const identity = loadIdentity(tlsFixtureHome());
  const f = await fixture({
    settings,
    files,
    ...(overrides.runtime ? { runtime: overrides.runtime } : {}),
    log: (error) => logs.push(error),
    now: () => now,
    remoteConfig: config,
    webRoot,
    hostName: "Office Mac",
    network: {
      identity: () => identity,
      interfaces: () => ({}),
      status: async () => {
        if (!networkAvailable) throw new Error("No Tailscale");
        if (!overrides.transport) throw new Error("No Tailscale");
        const tailnet = overrides.tailnet ? overrides.tailnet.ips : ["127.0.0.1"];
        if (!tailnet) throw new Error("Tailscale isn't answering");
        return JSON.stringify({ BackendState: "Running", TailscaleIPs: tailnet });
      },
      certificate: async () => {
        throw new Error("HTTPS certificates are off for this tailnet");
      },
    },
  });
  const client = await f.connect();
  await client.next();
  let id = 0;
  const set = async (
    key: "remote.enabled" | "remote.transport" | "remote.relayUrl",
    value: boolean | string,
  ) => {
    client.send({
      type: "settings.set",
      requestId: `set-${++id}`,
      key,
      value,
      layer: { kind: "global" },
    });
    return client.next();
  };
  const local = (path: string, body?: unknown) =>
    accessRequest(f.server.httpUrl, path, { token, ...(body ? { method: "POST", body } : {}) });
  const close = async () => {
    await f.close();
    await files.close();
    await settings.close();
    await rm(home, { recursive: true, force: true });
  };
  return {
    ...f,
    client,
    settings,
    identity,
    config,
    set,
    local,
    close,
    logs,
    recoverNetwork: () => {
      networkAvailable = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const codeOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("code");

test("a saved switch opens encrypted pairing immediately and turning it off keeps the host connected", async () => {
  const f = await runtime();
  let remoteClient: Client | undefined;
  try {
    await expect(f.local("/v1/pairings", {})).rejects.toThrow(/409/);
    expect(await f.set("remote.transport", "lan")).toMatchObject({ ok: true });
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    const pairing = PairingResponse.parse(
      await f.local("/v1/pairings", { scopes: ["read", "operate", "projects"] }),
    );
    const url = new URL(pairing.url);
    const page = await new Promise<string>((resolve, reject) => {
      // The public pairing page carries no credential in its request path.
      import("node:https").then(({ get }) => {
        const request = get(`${url.origin}/pair`, { rejectUnauthorized: false }, (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += String(chunk);
          });
          response.on("end", () => resolve(text));
        });
        request.on("error", reject);
      }, reject);
    });
    expect(page).toContain("Pair this device");
    const request = (path: string, body?: unknown, credential?: string) =>
      accessRequest(url.origin, path, {
        fingerprint: f.identity.fingerprint,
        ...(body ? { method: "POST", body } : {}),
        ...(credential ? { token: credential } : {}),
      });
    const code = new URLSearchParams(url.hash.slice(1)).get("code");
    const paired = DeviceCredential.parse(
      await request("/v1/pair", { code, name: "My phone", scopes: ["admin"] }),
    );
    expect(paired.device.scopes).toEqual(["read", "operate", "projects"]);
    await expect(request("/v1/pair", { code, name: "Second phone" })).rejects.toThrow(/401/);
    await expect(request("/v1/tickets", {}, token)).rejects.toThrow(/401/);
    const ticket = SocketTicket.parse(await request("/v1/tickets", {}, paired.token));
    remoteClient = new Client(url.origin.replace("https:", "wss:"), { rejectUnauthorized: false });
    await once(remoteClient.socket, "open");
    remoteClient.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: paired.device.id,
      ticket: ticket.ticket,
    });
    expect(await remoteClient.next()).toMatchObject({ type: "welcome" });
    remoteClient.send({ type: "host.identity", requestId: "identity" });
    expect(await remoteClient.next()).toMatchObject({ identity: { displayName: "Office Mac" } });
    const unauthenticated = new Client(url.origin.replace("https:", "wss:"), {
      rejectUnauthorized: false,
    });
    await once(unauthenticated.socket, "open");
    const pendingClosed = once(unauthenticated.socket, "close");
    const closed = once(remoteClient.socket, "close");
    expect(await f.set("remote.enabled", false)).toMatchObject({ ok: true });
    await closed;
    await pendingClosed;
    expect(await f.local("/v1/status")).toMatchObject({ remote: null });
    await expect(request("/v1/tickets", {}, paired.token)).rejects.toThrow();
    f.client.send({ type: "host.identity", requestId: "still-local" });
    expect(await f.client.next()).toMatchObject({ identity: { displayName: "Office Mac" } });
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    expect(await f.local("/v1/devices")).toMatchObject([
      { name: "My phone", scopes: ["read", "operate", "projects"] },
    ]);
  } finally {
    await remoteClient?.close();
    await f.close();
  }
});

test("saved remote access opens at startup without a launch override", async () => {
  const f = await runtime({ enabled: true });
  try {
    expect(await f.local("/v1/status")).toMatchObject({
      remoteAccess: { enabled: true, transport: "lan", listenOverride: null, relayOverride: false },
    });
    expect(PairingResponse.parse(await f.local("/v1/pairings", {})).url).toContain("/pair#");
    expect(await f.set("remote.enabled", false)).toMatchObject({ ok: true });
    expect(await f.local("/v1/status")).toMatchObject({
      remoteAccess: { enabled: false, transport: "local" },
    });
  } finally {
    await f.close();
  }
});

test("an unavailable Tailscale network cannot change the saved transport or expose a LAN listener", async () => {
  const f = await runtime();
  try {
    expect(await f.set("remote.transport", "tailscale")).toMatchObject({ ok: true });
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: false });
    expect((await f.settings.get("remote.enabled")).value).toBe(false);
    expect(await f.local("/v1/status")).toMatchObject({ remote: null });
    expect(await f.set("remote.transport", "lan")).toMatchObject({ ok: true });
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    const before = f.server.remoteUrl;
    expect(await f.set("remote.transport", "tailscale")).toMatchObject({ ok: false });
    expect(f.server.remoteUrl).toBe(before);
    expect((await f.settings.get("remote.transport")).value).toBe("lan");
  } finally {
    await f.close();
  }
});

test("an explicit launch override stays in force when saved settings change", async () => {
  const f = await runtime({ listen: "local", enabled: true });
  try {
    expect(await f.set("remote.transport", "lan")).toMatchObject({ ok: true });
    expect(await f.local("/v1/status")).toMatchObject({ remote: null });
  } finally {
    await f.close();
  }
});

test("paired operators cannot change global remote settings or machine identity", async () => {
  const f = await runtime();
  try {
    const issued = f.store.devices.create("Operator", ["read", "operate"], 1000);
    const ticket = SocketTicket.parse(
      await accessRequest(f.server.httpUrl, "/v1/tickets", { method: "POST", token: issued.token }),
    );
    const client = await f.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(issued.device.id),
      ticket: ticket.ticket,
    });
    await client.next();
    for (const key of ["remote.enabled", "host.displayName"] as const) {
      client.send({
        type: "settings.set",
        requestId: key,
        key,
        value: key === "remote.enabled" ? true : "Hacked",
        layer: { kind: "global" },
      });
      expect(await client.next()).toMatchObject({ ok: false });
    }
    expect(await f.local("/v1/status")).toMatchObject({ remote: null });
  } finally {
    await f.close();
  }
});

test("relay starts and stops on saved settings without replacing the host socket", async () => {
  const relay = await startRelay();
  const f = await runtime();
  try {
    const issued = f.store.devices.create("Phone", ["read"], 1000);
    expect(await f.set("remote.relayUrl", relay.url)).toMatchObject({ ok: true });
    expect(await f.set("remote.transport", "relay")).toMatchObject({ ok: true });
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    const keys = await loadOrCreateHostKeys(join(f.config.dataDir, "relay"));
    const pin = fingerprint(keys.publicKey);
    const connect = () =>
      connectClientViaRelay({ relayUrl: relay.url, hostId: pin, pinnedFingerprint: pin });
    const channel = await connect();
    await channel.send({
      type: "hello",
      channel: "files",
      protocolVersion: 1,
      deviceId: issued.device.id,
      token: issued.token,
    });
    expect(await channel.receive()).toMatchObject({ type: "welcome", hostId: "host" });
    // Status names the route a paired client just used: the relay, its pinned key, the host.
    expect(await f.local("/v1/status")).toMatchObject({
      remoteAccess: {
        enabled: true,
        transport: "relay",
        relay: { url: relay.url, fingerprint: pin, hostId: "host" },
      },
    });
    expect(PairingResponse.parse(await f.local("/v1/pairings", {})).url).toContain("/pair#");
    expect(await f.set("remote.transport", "lan")).toMatchObject({ ok: true });
    expect(await f.local("/v1/status")).toMatchObject({
      remoteAccess: { enabled: true, transport: "relay" },
    });
    expect(await f.set("remote.enabled", false)).toMatchObject({ ok: true });
    await channel.closed;
    expect(await f.local("/v1/status")).not.toHaveProperty("remoteAccess.relay");
    await expect(connect()).rejects.toThrow();
    f.client.send({ type: "host.identity", requestId: "host-after-relay" });
    expect(await f.client.next()).toMatchObject({ identity: { displayName: "Office Mac" } });
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    const again = await connect();
    await again.send({
      type: "hello",
      channel: "files",
      protocolVersion: 1,
      deviceId: issued.device.id,
      token: issued.token,
    });
    expect(await again.receive()).toMatchObject({ type: "welcome" });
    again.close();
  } finally {
    await f.close();
    await relay.close();
  }
});

test("pairing codes expire after five minutes and switching remote access off invalidates unused links", async () => {
  const f = await runtime();
  try {
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    const expired = PairingResponse.parse(await f.local("/v1/pairings", {}));
    expect(expired.expiresAt).toBe(301000);
    f.advance(300000);
    await expect(
      accessRequest(new URL(expired.url).origin, "/v1/pair", {
        method: "POST",
        fingerprint: f.identity.fingerprint,
        body: { code: codeOf(expired.url), name: "Late phone" },
      }),
    ).rejects.toThrow(/401/);
    const pending = PairingResponse.parse(await f.local("/v1/pairings", {}));
    expect(await f.set("remote.enabled", false)).toMatchObject({ ok: true });
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    const origin = f.server.remoteUrl?.replace("wss:", "https:");
    if (!origin) throw new Error("Listener missing");
    await expect(
      accessRequest(origin, "/v1/pair", {
        method: "POST",
        fingerprint: f.identity.fingerprint,
        body: { code: codeOf(pending.url), name: "Old link" },
      }),
    ).rejects.toThrow(/401/);
    expect(await f.local("/v1/devices")).toEqual([]);
  } finally {
    await f.close();
  }
});

test("saved unavailable remote access leaves local sessions usable and retries until the network returns", async () => {
  const timers: { ms: number; run(): void }[] = [];
  const f = await runtime({
    enabled: true,
    unavailable: true,
    transport: "tailscale",
    runtime: {
      delay(run, ms) {
        const item = { ms, run };
        timers.push(item);
        return () => {
          const at = timers.indexOf(item);
          if (at >= 0) timers.splice(at, 1);
        };
      },
    },
  });
  try {
    expect(await f.local("/v1/status")).toMatchObject({
      remote: null,
      remoteAccess: { enabled: false, error: expect.stringContaining("Tailscale") },
    });
    f.client.send({ type: "host.identity", requestId: "local-works" });
    expect(await f.client.next()).toMatchObject({ identity: { displayName: "Office Mac" } });
    expect(f.logs.length).toBeGreaterThan(0);
    expect(timers[0]?.ms).toBe(1000);
    f.recoverNetwork();
    timers.shift()?.run();
    // Public settings write joins the serialized retry queue, providing a completion barrier.
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
    expect(await f.local("/v1/status")).toMatchObject({
      remoteAccess: { enabled: true, transport: "tailscale" },
    });
    expect(PairingResponse.parse(await f.local("/v1/pairings", {})).url).toContain("/pair#");
  } finally {
    await f.close();
  }
});

test("a rejected saved relay leaves startup, local conversations and direct pairing usable", async () => {
  const relay = await startRelay({ allowedHostIds: [] });
  const retries: number[] = [];
  const callbacks: (() => void)[] = [];
  const f = await runtime({
    enabled: true,
    transport: "relay",
    relayUrl: relay.url,
    runtime: {
      delay(run, ms) {
        callbacks.push(run);
        retries.push(ms);
        return () => {};
      },
    },
  });
  try {
    expect(await f.local("/v1/status")).toMatchObject({
      remoteAccess: { enabled: true, transport: "lan", error: expect.stringContaining("relay") },
    });
    f.client.send({ type: "host.identity", requestId: "relay-outage-local" });
    expect(await f.client.next()).toMatchObject({ identity: { displayName: "Office Mac" } });
    const pairing = PairingResponse.parse(await f.local("/v1/pairings", {}));
    const url = new URL(pairing.url);
    callbacks.shift()?.();
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: false });
    expect(
      new URL(f.server.remoteUrl ?? "https://missing.invalid").origin.replace("wss:", "https:"),
    ).toBe(url.origin);
    const paired = DeviceCredential.parse(
      await accessRequest(url.origin, "/v1/pair", {
        fingerprint: f.identity.fingerprint,
        method: "POST",
        body: { code: codeOf(pairing.url), name: "My laptop" },
      }),
    );
    expect(paired.device.name).toBe("My laptop");
    expect(retries[0]).toBe(1000);
  } finally {
    await f.close();
    await relay.close();
  }
});

test("a rejected relay edit restores the saved relay and preserves direct pairing", async () => {
  const saved = await startRelay();
  const rejected = await startRelay({ allowedHostIds: [] });
  const f = await runtime({ enabled: true, transport: "relay", relayUrl: saved.url });
  try {
    const issued = f.store.devices.create("Phone", ["read"], 1000);
    const keys = await loadOrCreateHostKeys(join(f.config.dataDir, "relay"));
    const pin = fingerprint(keys.publicKey);
    const pairing = PairingResponse.parse(await f.local("/v1/pairings", {}));
    const connect = async () => {
      const channel = await connectClientViaRelay({
        relayUrl: saved.url,
        hostId: pin,
        pinnedFingerprint: pin,
      });
      try {
        await channel.send({
          type: "hello",
          channel: "files",
          protocolVersion: 1,
          deviceId: issued.device.id,
          token: issued.token,
        });
        expect(await channel.receive()).toMatchObject({ type: "welcome" });
      } finally {
        channel.close();
        await channel.closed;
      }
    };
    await connect();
    expect(await f.set("remote.relayUrl", rejected.url)).toMatchObject({ ok: false });
    expect((await f.settings.get("remote.relayUrl")).value).toBe(saved.url);
    expect(await f.local("/v1/status")).toMatchObject({
      remoteAccess: { enabled: true, transport: "relay" },
    });
    expect(new URL(PairingResponse.parse(await f.local("/v1/pairings", {})).url).origin).toBe(
      new URL(pairing.url).origin,
    );
    await connect();
    expect(await f.set("remote.relayUrl", saved.url)).toMatchObject({ ok: true });
    await connect();
    const paired = DeviceCredential.parse(
      await accessRequest(new URL(pairing.url).origin, "/v1/pair", {
        fingerprint: f.identity.fingerprint,
        method: "POST",
        body: { code: codeOf(pairing.url), name: "Laptop" },
      }),
    );
    expect(paired.device.name).toBe("Laptop");
  } finally {
    await f.close();
    await rejected.close();
    await saved.close();
  }
});

test("a pairing link is not issued for remote access that turned off while the link was being made", async () => {
  const release = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const f = await runtime({
    enabled: true,
    holdPairingLinkSetting: { until: release.promise, onHold: () => held.resolve() },
  });
  try {
    const requestId = "pairing-during-change";
    f.client.send({
      type: "fleet.request",
      requestId,
      operation: { op: "pairing", scopes: ["read"] },
    });
    await held.promise;
    expect(await f.set("remote.enabled", false)).toMatchObject({ ok: true });
    release.resolve();
    for (;;) {
      const message = await f.client.next();
      if (!("requestId" in message) || message.requestId !== requestId) continue;
      expect(message).toMatchObject({ type: "error", code: "unavailable" });
      break;
    }
    expect(await f.local("/v1/status")).toMatchObject({ remote: null });
  } finally {
    await f.close();
  }
});

test("remote access moves to this machine's new Tailscale address, and a failed check keeps it open", async () => {
  const checks: (() => void)[] = [];
  const tailnet: { ips: string[] | undefined } = { ips: ["0.0.0.0"] };
  const f = await runtime({
    enabled: true,
    transport: "tailscale",
    tailnet,
    runtime: {
      every(run, ms) {
        if (ms === addressCheckMs) checks.push(run);
        return () => {};
      },
    },
  });
  const check = async () => {
    for (const run of checks) run();
    // A settings write joins the same serialized queue as the check: once it answers, the
    // check has run.
    expect(await f.set("remote.enabled", true)).toMatchObject({ ok: true });
  };
  const linkOrigin = async () =>
    new URL(PairingResponse.parse(await f.local("/v1/pairings", {})).url).origin;
  try {
    const before = await linkOrigin();
    expect(new URL(before).hostname).toBe("0.0.0.0");

    // Tailscale not answering for a moment never takes a working listener down.
    tailnet.ips = undefined;
    await check();
    expect(await linkOrigin()).toBe(before);

    // Tailscale gave this machine another address: links name it, and pairing works there.
    tailnet.ips = ["127.0.0.1"];
    await check();
    const after = await linkOrigin();
    expect(new URL(after).hostname).toBe("127.0.0.1");
    const pairing = PairingResponse.parse(await f.local("/v1/pairings", {}));
    const paired = DeviceCredential.parse(
      await accessRequest(new URL(pairing.url).origin, "/v1/pair", {
        fingerprint: f.identity.fingerprint,
        method: "POST",
        body: { code: codeOf(pairing.url), name: "Rijan's Mac" },
      }),
    );
    expect(paired.device.name).toBe("Rijan's Mac");
    // Nothing listens on the old address any more.
    await expect(
      accessRequest(`https://127.0.0.1:${new URL(before).port}`, "/v1/pair", {
        fingerprint: f.identity.fingerprint,
        method: "POST",
        body: { code: "000000", name: "Old address" },
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
