import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { CheckResult } from "@ace/diagnostics";
import type { RemotePreferences } from "../remote-policy.ts";
import type { DoctorContext } from "./feature.ts";
import { remoteAccessPorts, type RemoteAccessPorts } from "./remote-access-facts.ts";
import { remoteAccessFeature } from "./remote-access.ts";
import { doctorTestContext } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const signal = new AbortController().signal;
const day = 24 * 60 * 60 * 1000;
/** notAfter of __fixtures__/remote-access-cert.pem, a self-signed certificate made with openssl. */
const fixtureExpiry = Date.parse("2036-10-18T20:54:59Z");
const lan: RemotePreferences = {
  "remote.enabled": true,
  "remote.transport": "lan",
  "remote.relayUrl": "",
};
const tailscale: RemotePreferences = { ...lan, "remote.transport": "tailscale" };

async function verdicts(context: DoctorContext, ports: RemoteAccessPorts = remoteAccessPorts) {
  const results = new Map<string, Omit<CheckResult, "id">>();
  for (const check of remoteAccessFeature(ports).checks(context))
    results.set(check.id, await check.run(signal));
  return results;
}

function fakePorts(overrides: Partial<RemoteAccessPorts>): RemoteAccessPorts {
  return {
    ...remoteAccessPorts,
    tailscale: async () => "/usr/local/bin/tailscale",
    network: {
      interfaces: () => ({
        en0: [
          {
            address: "192.168.1.20",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "192.168.1.20/24",
          },
        ],
      }),
      status: async () =>
        JSON.stringify({
          BackendState: "Running",
          TailscaleIPs: ["100.64.0.1"],
          Self: { DNSName: "studio-mac.tail1234.ts.net." },
          CurrentTailnet: { MagicDNSEnabled: true },
        }),
    },
    ...overrides,
  };
}

it("with remote access off, doctor says so and nothing needs attention", async () => {
  const { context, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const results = await verdicts(context);
  expect(results.get("remote.access")).toMatchObject({
    status: "ok",
    message: "Remote access is off",
  });
  expect([...results.values()].every((verdict) => verdict.status === "ok")).toBe(true);
});

it("saved settings turn remote access on, and paired devices are counted without local ones", async () => {
  const { context, dataDir, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  await writeFile(
    join(dataDir, "settings.json"),
    JSON.stringify({ version: 2, settings: { "remote.enabled": true, "remote.transport": "lan" } }),
  );
  const db = new DatabaseSync(join(dataDir, "events.sqlite"));
  db.exec(`CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes JSON NOT NULL,
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER)`);
  const insert = db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, 0, 0, ?)");
  insert.run("phone", "Phone", "a", JSON.stringify(["read", "operate"]), null);
  insert.run("old", "Old laptop", "b", JSON.stringify(["read"]), 5);
  insert.run("desktop", "ace desktop", "c", JSON.stringify(["desktop"]), null);
  db.close();

  const results = await verdicts(
    context,
    fakePorts({
      preferences: remoteAccessPorts.preferences,
      pairedDevices: remoteAccessPorts.pairedDevices,
    }),
  );
  expect(results.get("remote.access")).toMatchObject({
    status: "ok",
    message: `Remote access is on: LAN at 192.168.1.20:${context.config.remotePort} · 1 paired device`,
  });
});

it("a certificate expiring within two weeks warns, and so does an expired one", async () => {
  const { context, dataDir, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  await mkdir(join(dataDir, "tls"));
  await copyFile(
    join(import.meta.dirname, "__fixtures__", "remote-access-cert.pem"),
    join(dataDir, "tls", "cert.pem"),
  );
  const at = async (now: number) =>
    (
      await verdicts({ ...context, now: () => now }, fakePorts({ preferences: async () => lan }))
    ).get("remote.certificate");

  expect(await at(fixtureExpiry - 30 * day)).toMatchObject({
    status: "ok",
    message: "Certificate valid until 2036-10-18",
  });
  const expiring = await at(fixtureExpiry - 5 * day);
  expect(expiring).toMatchObject({
    status: "warn",
    message: "The remote access certificate expires on 2036-10-18, in 5 days",
  });
  expect(expiring?.fix).toContain("tls aside");
  expect(await at(fixtureExpiry + day)).toMatchObject({
    status: "warn",
    message: "The remote access certificate expired on 2036-10-18; devices can't connect",
  });
});

it("Tailscale remote access warns when Tailscale is missing or not connected", async () => {
  const { context, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const access = async (overrides: Partial<RemoteAccessPorts>) =>
    (await verdicts(context, fakePorts({ preferences: async () => tailscale, ...overrides }))).get(
      "remote.access",
    );

  expect(await access({ tailscale: async () => undefined })).toMatchObject({
    status: "warn",
    message: "Remote access uses Tailscale, but the tailscale command isn't installed",
  });
  expect(
    await access({
      network: {
        interfaces: () => ({}),
        status: async () => JSON.stringify({ BackendState: "Stopped", TailscaleIPs: [] }),
      },
    }),
  ).toMatchObject({
    status: "warn",
    message: "Remote access uses Tailscale, but it isn't connected (Stopped)",
  });
  expect(await access({})).toMatchObject({
    status: "ok",
    message: `Remote access is on: Tailscale at studio-mac.tail1234.ts.net:${context.config.remotePort}`,
  });
});

it("Tailscale access uses the tailnet's ts.net name, and the 100.x address only without MagicDNS", async () => {
  const { context, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const where = async (status: object) =>
    (
      await verdicts(
        context,
        fakePorts({
          preferences: async () => tailscale,
          network: { interfaces: () => ({}), status: async () => JSON.stringify(status) },
        }),
      )
    ).get("remote.access")?.message;
  const running = { BackendState: "Running", TailscaleIPs: ["fd7a:115c::1", "100.64.0.1"] };

  expect(await where({ ...running, Self: { DNSName: "Studio-Mac.tail1234.ts.net." } })).toBe(
    `Remote access is on: Tailscale at studio-mac.tail1234.ts.net:${context.config.remotePort}`,
  );
  expect(
    await where({
      ...running,
      Self: { DNSName: "studio-mac.tail1234.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: false },
    }),
  ).toBe(`Remote access is on: Tailscale at 100.64.0.1:${context.config.remotePort}`);
  expect(await where({ ...running, Self: { DNSName: "" } })).toBe(
    `Remote access is on: Tailscale at 100.64.0.1:${context.config.remotePort}`,
  );
});

it("over Tailscale, doctor warns until the tailnet can issue this machine's HTTPS certificate", async () => {
  const { context, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const https = async (status: object) =>
    (
      await verdicts(
        context,
        fakePorts({
          preferences: async () => tailscale,
          network: { interfaces: () => ({}), status: async () => JSON.stringify(status) },
        }),
      )
    ).get("remote.tailscale-https");
  const running = {
    BackendState: "Running",
    TailscaleIPs: ["100.64.0.1"],
    Self: { DNSName: "studio-mac.tail1234.ts.net." },
  };

  expect(await https({ ...running, CertDomains: null })).toMatchObject({
    status: "warn",
    message:
      "Browsers can't pair over Tailscale: HTTPS certificates are off for studio-mac.tail1234.ts.net",
  });
  expect(await https({ ...running, CertDomains: ["studio-mac.tail1234.ts.net"] })).toMatchObject({
    status: "ok",
    message: "Browsers trust studio-mac.tail1234.ts.net",
  });
  expect(
    (await verdicts(context, fakePorts({ preferences: async () => lan }))).get(
      "remote.tailscale-https",
    ),
  ).toMatchObject({ status: "ok" });
});

it("the relay transport still listens directly, and needs a saved relay address", async () => {
  const { context, cleanup } = await doctorTestContext();
  cleanups.push(cleanup);
  const relay = (relayUrl: string) =>
    verdicts(
      context,
      fakePorts({
        preferences: async () => ({
          ...lan,
          "remote.transport": "relay",
          "remote.relayUrl": relayUrl,
        }),
      }),
    );

  const results = await relay("wss://relay.example.com/");
  expect(results.get("remote.access")).toMatchObject({
    status: "ok",
    message: `Remote access is on: LAN at 192.168.1.20:${context.config.remotePort} · relay relay.example.com`,
  });
  expect(results.get("remote.certificate")).toMatchObject({
    status: "ok",
    message: "No certificate yet; ace makes one when remote access starts",
  });
  expect((await relay("")).get("remote.access")).toMatchObject({
    status: "warn",
    message: "Remote access is set to use a relay, but no relay address is saved",
  });
});
