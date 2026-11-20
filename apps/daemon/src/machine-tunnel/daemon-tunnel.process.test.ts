import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
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
  return { f, settings, machine, direct, relayed, open, daemonPorts };
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

test("a direct path with another certificate's pin, or another daemon's id, is never used", async () => {
  const port = await echoServer();
  const { machine, direct, relayed, open } = await daemon();
  // A certificate that isn't the pinned one fails before any credential is written.
  expect(await refusal(open({ ...direct, fingerprint: "0".repeat(64) }).open(port))).toBe(
    "offline",
  );
  // A welcome naming another daemon is refused on either kind of path.
  for (const path of [direct, relayed])
    expect(await refusal(open(path, { ...machine, expectedHostId: "elsewhere" }).open(port))).toBe(
      "offline",
    );
}, 30_000);
