import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MediaRuntime } from "@ace/media/runtime";
import { legacyMediaSettings, nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import type { FromMedia, ToMedia } from "@ace/media/wire";
import { DeviceId, type ClientMessage } from "@ace/protocol";
import { connectClientViaRelay, startRelay, type ClientChannel } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { startFilesRelay } from "../files-relay.ts";
import { RemoteAuth } from "../remote-auth.ts";
import { Store } from "../store.ts";
import { MediaRelayStreams } from "./streams.ts";

// A relay media stream end to end (D2): the real self-hosted relay, the real ace-media binary
// under its supervisor, the daemon's relay host with real pairing credentials, and a client
// through the relay. The handshake and hello run through ace-media; after the keys ace-media
// alone answers the client. Needs ACE_MEDIA_TEST_BINARY (`bun run check:media` sets it).
const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function setup() {
  if (!binary) throw new Error("ACE_MEDIA_TEST_BINARY is required");
  const root = await mkdtemp(join(tmpdir(), "ace-d2-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "store.sqlite"));
  cleanups.push(() => store.close());
  const auth = new RemoteAuth(store.devices, "host-local-token", {
    now: () => 1,
    secret: randomUUID,
  });
  const pair = () => {
    const { device, token } = auth.redeem(auth.pairing(["admin"]).code, "phone");
    return { deviceId: device.id, token };
  };
  const phone = pair();
  const tablet = pair();

  const logs: string[] = [];
  const sent: { message: ToMedia; payload: Uint8Array; copy: Uint8Array }[] = [];
  const received: FromMedia[] = [];
  let streams: MediaRelayStreams | undefined;
  const keys = keyPair();
  const runtimeDir = await mkdtemp(join(tmpdir(), "ace-d2m-"));
  cleanups.push(() => rm(runtimeDir, { recursive: true, force: true }));
  const runtime = new MediaRuntime({
    version: execFileSync(binary, ["--version"]).toString().trim(),
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ ...legacyMediaSettings, delivery: "auto" }),
    host: nodeMediaHost(process.env, (path) => ({ command: path, args: [] })),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: randomUUID,
    onMessage: (message, payload) => {
      received.push(message);
      streams?.onMessage(message, payload);
    },
    onExit: () => streams?.onExit(),
    log: (level, message, fields) => logs.push(`${level} ${message} ${JSON.stringify(fields)}`),
  });
  const supervisor = runtime.supervisor;
  cleanups.push(() => supervisor.dispose());
  streams = new MediaRelayStreams({
    link: {
      send(message, payload = new Uint8Array(0)) {
        // The test keeps a copy of the key block to scan for; the daemon itself never does.
        sent.push({ message, payload, copy: payload.slice() });
        return supervisor.send(message, payload);
      },
      closeStream: (message) => void supervisor.revoke(message),
      need: () => supervisor.need(),
      available: () => supervisor.health() !== "unavailable",
    },
    clock: systemMediaClock,
    hostKeys: keys,
    ephemeralKey: keyPair,
    newId: randomUUID,
    log: (line) => logs.push(line),
  });
  const relay = await startRelay({ limits: { messagesPerSecond: 100_000, messageBurst: 100_000 } });
  cleanups.push(() => relay.close());
  const host = await startFilesRelay({
    url: relay.url,
    keys,
    auth,
    devices: store.devices,
    store,
    hostId: "daemon-relay-host",
    headSeq: () => 0,
    media: {
      streams,
      claim: (ticket, claimant) => runtime.connections.claimRelay(ticket, claimant),
    },
  });
  cleanups.push(() => host.close());

  /** `media.connect` on the phone's (or another device's) main session: its ticket. */
  async function mint(device: string, session = "s1"): Promise<string> {
    const hold = supervisor.need();
    cleanups.push(hold);
    await until(() => (supervisor.listening()?.loopbackPort ?? 0) > 0);
    const granted = runtime.connections.connect({
      session,
      device,
      admission: { kind: "pairing", generation: 1 },
    });
    if (!granted.ok) throw new Error(granted.code);
    return granted.ticket;
  }

  async function open(purpose?: "media"): Promise<ClientChannel> {
    const client = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId: host.hostId,
      pinnedFingerprint: fingerprint(keys.publicKey),
      ...(purpose ? { purpose } : {}),
    });
    cleanups.push(() => client.close());
    return client;
  }
  function hello(
    credential: { deviceId: string; token: string },
    extra: Partial<Extract<ClientMessage, { type: "hello" }>>,
  ): Extract<ClientMessage, { type: "hello" }> {
    return {
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(credential.deviceId),
      token: credential.token,
      flowControl: ["credit"],
      ...extra,
    };
  }
  /** A media stream through ace-media with the client's hello, then what came back first. */
  async function media(
    credential: { deviceId: string; token: string },
    ticket: string | undefined,
    channel: "media" | "files" = "media",
  ) {
    const client = await open("media");
    client.flowControl?.();
    await client.send(
      hello(credential, { channel, ...(ticket !== undefined ? { mediaTicket: ticket } : {}) }),
    );
    return { client, first: await client.receive() };
  }
  return {
    runtime,
    supervisor,
    streams,
    sent,
    received,
    logs,
    mint,
    phone,
    tablet,
    open,
    hello,
    media,
  };
}

describe.skipIf(!binary)("relay media streams through ace-media", { timeout: 30_000 }, () => {
  it("hands a stream to ace-media with no frame lost or replayed, and keeps its keys out of every log", async () => {
    const t = await setup();
    const ticket = await t.mint(t.phone.deviceId);
    const client = await t.open("media");
    client.flowControl?.();
    await client.send(t.hello(t.phone, { channel: "media", mediaTicket: ticket }));
    // The client keeps talking before it hears the welcome: those frames are ace-media's to
    // open after the hand-over, so each ping must come back exactly once.
    const pings = 40;
    for (let i = 0; i < pings; i++) await client.send({ type: "ping" });
    expect(await client.receive()).toMatchObject({ type: "welcome" });
    for (let i = 0; i < pings; i++) expect(await client.receive()).toEqual({ type: "pong" });
    // And the stream keeps going in both directions once ace-media holds it.
    await client.send({ type: "ping" });
    expect(await client.receive()).toEqual({ type: "pong" });

    const handed = t.sent.find((s) => s.message.type === "relay.keys");
    if (!handed) throw new Error("no relay.keys");
    expect(t.received.some((m) => m.type === "connection.open")).toBe(true);
    // The daemon's block is zeroed once its write completed.
    await until(() => handed.payload.every((byte) => byte === 0));
    const secrets = [handed.copy.subarray(0, 32), handed.copy.subarray(32, 64)];
    const logged = t.logs.join("\n") + (t.supervisor.snapshot().lastExit?.stderr ?? []).join("\n");
    for (const key of secrets) {
      expect(logged).not.toContain(hex(key));
      expect(logged).not.toContain(b64(key));
    }
    expect(t.logs.some((line) => /^relay\.keys \{rs_[^}]+\}$/.test(line))).toBe(true);
  });

  it("refuses media hellos that name another channel, lack a ticket, reuse one or come from another device", async () => {
    const t = await setup();
    const ticket = await t.mint(t.phone.deviceId);
    const files = await t.media(t.phone, ticket, "files");
    expect(files.first).toMatchObject({ type: "error", code: "unauthorized" });
    const none = await t.media(t.phone, undefined);
    expect(none.first).toMatchObject({ type: "error" });
    // The files attempt never reached the claim, so the ticket still opens once, then never.
    const ok = await t.media(t.phone, ticket);
    expect(ok.first).toMatchObject({ type: "welcome" });
    const reused = await t.media(t.phone, ticket);
    expect(reused.first).toMatchObject({ type: "error", code: "unauthorized" });
    const stolen = await t.media(t.tablet, await t.mint(t.phone.deviceId));
    expect(stolen.first).toMatchObject({ type: "error", code: "unauthorized" });
    const badToken = await t.media(
      { deviceId: t.phone.deviceId, token: "wrong" },
      await t.mint(t.phone.deviceId),
    );
    expect(badToken.first).toMatchObject({ type: "error", code: "unauthorized" });
    // Only the one admitted stream got keys.
    expect(t.sent.filter((s) => s.message.type === "relay.keys")).toHaveLength(1);
  });

  it("refuses a media hello on a stream the relay didn't open for media", async () => {
    const t = await setup();
    const client = await t.open();
    await client.send(
      t.hello(t.phone, { channel: "media", mediaTicket: await t.mint(t.phone.deviceId) }),
    );
    expect(await client.receive()).toMatchObject({ type: "error", code: "unauthorized" });
    await client.closed;
    expect(t.sent.some((s) => s.message.type === "relay.dial")).toBe(false);
  });

  it("a revocation shuts the client's relay stream and is answered within 50 ms", async () => {
    const t = await setup();
    const { client, first } = await t.media(t.phone, await t.mint(t.phone.deviceId));
    expect(first).toMatchObject({ type: "welcome" });
    const started = performance.now();
    expect(
      await t.supervisor.revoke({
        type: "revoke",
        id: "rv1",
        issued: 1_000,
        device: t.phone.deviceId,
      }),
    ).toBe("answered");
    expect(performance.now() - started).toBeLessThan(50);
    await client.closed;
  });

  it("after ace-media is killed the client's stream ends, and a new stream is handed over by the restarted process", async () => {
    const t = await setup();
    const before = await t.media(t.phone, await t.mint(t.phone.deviceId));
    expect(before.first).toMatchObject({ type: "welcome" });
    const pid = t.supervisor.snapshot().pid;
    if (!pid) throw new Error("no pid");
    process.kill(pid, "SIGKILL");
    await before.client.closed;
    // Nothing holds ace-media up now; the next stream's need starts it again.
    const after = await t.media(t.phone, await t.mint(t.phone.deviceId));
    expect(after.first).toMatchObject({ type: "welcome" });
    await after.client.send({ type: "ping" });
    expect(await after.client.receive()).toEqual({ type: "pong" });
  });

  it("a stopped ace-media is killed 250 ms into a revocation, and the client's stream closes soon after", async () => {
    const t = await setup();
    const { client, first } = await t.media(t.phone, await t.mint(t.phone.deviceId));
    expect(first).toMatchObject({ type: "welcome" });
    const pid = t.supervisor.snapshot().pid;
    if (!pid) throw new Error("no pid");
    process.kill(pid, "SIGSTOP");
    const started = performance.now();
    const result = await t.supervisor.revoke({
      type: "revoke",
      id: "rv2",
      issued: 1_000,
      device: t.phone.deviceId,
    });
    const killedAt = performance.now() - started;
    expect(result).toBe("killed");
    expect(killedAt).toBeGreaterThanOrEqual(240);
    expect(killedAt).toBeLessThan(400);
    await client.closed;
    expect(performance.now() - started - killedAt).toBeLessThan(500);
  });
});
