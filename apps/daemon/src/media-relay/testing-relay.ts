// Test support for the relay media process tests: the real self-hosted relay, the real
// ace-media binary under MediaRuntime, startFilesRelay with real pairing credentials, and the
// client's side. Needs ACE_MEDIA_TEST_BINARY (`bun run check:media` sets it).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { tabProducer } from "./testing-producer.ts";
import { StreamAssembler, decodeStreamMessage } from "@ace/browser/stream";

export const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || undefined;

export async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function hello(
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

/** The first browser video chunk a relay client gets: whether it was a keyframe. */
export async function firstChunk(client: ClientChannel): Promise<boolean> {
  const assembler = new StreamAssembler();
  for (;;) {
    const frame = await client.receiveFrame();
    if (!(frame instanceof Uint8Array)) continue;
    const envelope = assembler.push(frame);
    const message = envelope && decodeStreamMessage(envelope);
    if (message?.kind === "browser.video") return message.chunk.key;
  }
}

/** A wss:// leg for ace-media: the relay serves `cert` too, and ace-media trusts only `trust`. */
export type RelayTls = { cert: string; key: string; trust: string; host: string };

/**
 * One harness. With `tls`, ace-media dials the relay's TLS listener as `host` (the daemon's own
 * relay legs stay on the plain listener), trusting only the `trust` CA (as `SSL_CERT_FILE`,
 * which replaces the OS store for that process alone).
 */
export async function setup(cleanups: (() => unknown)[], tls?: RelayTls) {
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
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  /** The relay's join address, on its TLS listener under the certificate's host name. */
  const overTls = (message: ToMedia, leg: RelayTls): ToMedia => {
    if (message.type !== "relay.dial" || !relay?.tlsPort) return message;
    const plain = new URL(message.url);
    return {
      ...message,
      url: `wss://${leg.host}:${relay.tlsPort}${plain.pathname}${plain.search}`,
    };
  };
  const keys = keyPair();
  const runtimeDir = await mkdtemp(join(tmpdir(), "ace-d2m-"));
  cleanups.push(() => rm(runtimeDir, { recursive: true, force: true }));
  const runtime = new MediaRuntime({
    version: execFileSync(binary, ["--version"]).toString().trim(),
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ ...legacyMediaSettings, encode: "auto", delivery: "auto" }),
    capabilities: { ingest: ["tab"], recordings: false, stills: false, delivery: true },
    host: nodeMediaHost(
      { ...process.env, ...(tls ? { SSL_CERT_FILE: tls.trust } : {}) },
      (path) => ({ command: path, args: [] }),
    ),
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
      send(original, payload = new Uint8Array(0)) {
        const message = tls ? overTls(original, tls) : original;
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
  relay = await startRelay({
    limits: { messagesPerSecond: 100_000, messageBurst: 100_000 },
    ...(tls ? { tls: { cert: tls.cert, key: tls.key } } : {}),
  });
  const served = relay;
  cleanups.push(() => served.close());
  const host = await startFilesRelay({
    url: served.url,
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
    const granted = await runtime.connections.connect({
      session,
      device,
      admission: { kind: "pairing", generation: 1 },
    });
    if (!granted.ok) throw new Error(granted.code);
    return granted.ticket;
  }

  async function open(purpose?: "media"): Promise<ClientChannel> {
    const client = await connectClientViaRelay({
      relayUrl: served.url,
      hostId: host.hostId,
      pinnedFingerprint: fingerprint(keys.publicKey),
      ...(purpose ? { purpose } : {}),
    });
    cleanups.push(() => client.close());
    return client;
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
  /** A tab producing into ace-media, and a view of it bound to a relay connection. */
  function tab() {
    const producer = tabProducer("t1");
    cleanups.push(() => producer.stop());
    const source = runtime.sources.add(producer);
    return {
      source,
      bind(connection: string) {
        return runtime.viewers.bind({
          viewer: `tab-${connection}`,
          session: "s1",
          connection,
          target: { kind: "browser", threadId: "t1" },
          codecs: ["avc1.42E033"],
          viewport: { width: 800, height: 600, dpr: 1, scale: 1 },
          local: false,
          audio: false,
          shows: (p) => p.threadId === "t1",
        });
      },
    };
  }
  return {
    tab,
    firstChunk,
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
