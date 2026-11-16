import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { encodeMediaFrame } from "./frame.ts";
import type { IngestProducer } from "./ingest-sources.ts";
import type { MediaOwner } from "./media-connections.ts";
import type { ViewIntent } from "./media-viewers.ts";
import { MediaRuntime } from "./runtime.ts";
import { nodeMediaHost, systemMediaClock } from "./supervisor.ts";
import { MediaTestClient } from "./testing/media-test-client.ts";

// D1 end to end on the real ace-media: producers streaming into its ingest, a client's media
// connection on its direct listener, and the daemon's MediaConnections and MediaViewers between
// them. A real process and real sockets: what a pure test of either side can't show is that the
// grant, the ticket and the producer's units meet on one connection, and that a restart brings the
// picture back.

const built = fileURLToPath(
  new URL("../../../native/media/target/debug/ace-media", import.meta.url),
);
const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || (existsSync(built) ? built : undefined);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const unit = (key: boolean, n: number) =>
  encodeMediaFrame({
    kind: 1,
    flags: key ? 1 : 0,
    ageUs: 0,
    width: 640,
    height: 400,
    displayWidth: 640,
    displayHeight: 400,
    scale: 1000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 0,
    codecString: "avc1.42E033",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array([0, 0, 0, 1, key ? 0x65 : 0x41, n & 0xff]),
  });

/** A producer that, once pointed at ace-media, sends a keyframe every 10 units at 60 fps. */
function producer(
  ids: Partial<IngestProducer> & Pick<IngestProducer, "source" | "kind" | "origin">,
) {
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    socket?.destroy();
    socket = undefined;
  };
  cleanups.push(stop);
  const made: IngestProducer = {
    epoch: () => 0,
    consumers: { deliver: () => {}, record: () => {}, still: () => {} },
    keyframe: () => {},
    ...ids,
    point: (address) => {
      stop();
      if (!address) return Promise.resolve();
      const connection = createConnection(address.socket);
      socket = connection;
      connection.on("error", () => {});
      connection.write(
        encodeMediaFrame({
          kind: 5,
          flags: 0,
          ageUs: 0,
          width: 0,
          height: 0,
          displayWidth: 0,
          displayHeight: 0,
          scale: 0,
          rotation: 0,
          codec: 0,
          encode: 0,
          epoch: 0,
          codecString: "",
          description: new Uint8Array(0),
          extension: new Uint8Array(0),
          payload: address.token.slice(),
        }),
      );
      let n = 0;
      timer = setInterval(() => connection.write(unit(n % 10 === 0, n++)), 16);
      return Promise.resolve();
    },
  };
  return made;
}

function start() {
  if (!binary) throw new Error("no ace-media binary");
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-d1-"));
  let ids = 0;
  const runtime = new MediaRuntime({
    version: execFileSync(binary, ["--version"]).toString().trim(),
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    settings: () => ({ encode: "auto", delivery: "auto", recordings: "legacy", stills: "legacy" }),
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `id-${++ids}`,
    capabilities: {
      ingest: ["tab", "screen", "scrcpy"],
      recordings: false,
      stills: false,
      delivery: true,
    },
    log: () => {},
  });
  cleanups.push(() => {
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const sources = [
    runtime.sources.add(
      producer({ source: "tab", kind: "tab", origin: { kind: "tab" }, threadId: "t1" }),
    ),
    runtime.sources.add(
      producer({
        source: "screen",
        kind: "screen",
        origin: { kind: "screen", platform: "macos" },
        sessionId: "screen-1",
      }),
    ),
    runtime.sources.add(
      producer({
        source: "device",
        kind: "scrcpy",
        origin: { kind: "scrcpy", host: "127.0.0.1", port: 1 },
        deviceId: "android:emulator-5554",
      }),
    ),
  ];
  return { runtime, sources };
}

const owner: MediaOwner = {
  session: "main-1",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
};

function intents(connection: string): Omit<ViewIntent, "viewer">[] {
  const base = {
    requester: owner,
    connection,
    codecs: ["avc1.42E033"],
    viewport: { width: 800, height: 600, dpr: 1, scale: 1 },
    local: true,
    audio: false,
  };
  return [
    {
      ...base,
      target: { kind: "browser", threadId: "t1" },
      shows: (p) => p.threadId === "t1",
    },
    {
      ...base,
      target: { kind: "screen", sessionId: "screen-1" },
      shows: (p) => p.sessionId === "screen-1",
    },
    {
      ...base,
      target: { kind: "device", deviceId: "android:emulator-5554" },
      shows: (p) => p.deviceId === "android:emulator-5554",
    },
  ];
}

/** A connection with the three views bound, and the stream kinds of the pieces it gets. */
async function watch(runtime: MediaRuntime) {
  const kinds = new Set<number>();
  let first: number | undefined;
  const grant = await runtime.connections.connect(owner);
  if (!grant.ok) throw new Error(grant.code);
  const client = await MediaTestClient.open(grant, {
    onPiece: (piece, at) => {
      first ??= at;
      kinds.add(piece[5] ?? 0);
    },
  });
  cleanups.push(() => client.close());
  for (const intent of intents(grant.connection))
    expect(runtime.viewers.bind(intent)).toBeDefined();
  return { client, kinds, first: () => first };
}

it.skipIf(!binary)(
  "a tab, a screen and a device arrive on one media connection, which another device can't bind views onto",
  async () => {
    const { runtime, sources } = start();
    await until(() => sources.every((source) => source.streaming()));
    const { client, kinds } = await watch(runtime);
    // browserVideo, deviceFrame and screenFrame pieces, all on this one connection.
    await until(() => kinds.size === 3);
    expect([...kinds].toSorted()).toEqual([2, 4, 5]);
    expect(await client.ping()).toBeLessThan(1_000);
    // Another session can't bind a view onto this connection.
    // Another device can't bind a view onto this connection, from any session of its own.
    const stranger = {
      ...intents(client.connection)[0]!,
      requester: { ...owner, session: "laptop-channel", device: "laptop" },
    };
    expect(runtime.viewers.bind(stranger)).toBeUndefined();
    // The same device's own channel can (iOS subscribes to screens and devices on channels).
    const channel = {
      ...intents(client.connection)[1]!,
      requester: { ...owner, session: "screen-channel" },
    };
    expect(runtime.viewers.bind(channel)).toBeDefined();
  },
);

it.skipIf(!binary)("revoking the device closes its media connection within 250 ms", async () => {
  const { runtime, sources } = start();
  await until(() => sources.every((source) => source.streaming()));
  const { client } = await watch(runtime);
  const started = performance.now();
  void runtime.connections.revoke("phone", owner.admission);
  expect(await client.closed()).toBe(4403);
  const took = performance.now() - started;
  const load = loadavg()[0] ?? 0;
  console.info(`revoke → close ${Math.round(took)} ms at load ${Math.round(load)}`);
  expect(took).toBeLessThan(load >= 24 ? 1_000 : 250);
});

it.skipIf(!binary)(
  "after ace-media restarts, the client's picture is back within 2 s, p95 of five restarts",
  async () => {
    const took: number[] = [];
    // Each round is one restart of a process that was healthy: repeated kills of one process
    // back off on purpose (0.5 s, doubling).
    for (let round = 0; round < 5; round++) {
      const { runtime, sources } = start();
      await until(
        () => runtime.supervisor.health() === "healthy" && sources.every((s) => s.streaming()),
      );
      const before = await watch(runtime);
      await until(() => before.first() !== undefined);
      const pid = runtime.supervisor.snapshot().pid;
      const killed = performance.now();
      if (pid) process.kill(pid, "SIGKILL");
      await before.client.closed();
      // The client reconnects as soon as media.connect answers again, and resubscribes.
      let after: Awaited<ReturnType<typeof watch>> | undefined;
      await until(
        () => runtime.supervisor.health() === "healthy" && sources.every((s) => s.streaming()),
        5_000,
      );
      while (!after)
        try {
          after = await watch(runtime);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      await until(() => after?.first() !== undefined, 5_000);
      took.push((after.first() ?? Infinity) - killed);
      for (const cleanup of cleanups.splice(0)) cleanup();
    }
    const p95 = took.toSorted((a, b) => a - b)[Math.ceil(took.length * 0.95) - 1] ?? Infinity;
    const load = loadavg()[0] ?? 0;
    // Like the benches: on a machine this loaded the number is reported, not enforced.
    console.info(
      `restart → picture ${JSON.stringify(took.map(Math.round))} ms at load ${Math.round(load)}`,
    );
    expect(p95, JSON.stringify(took.map(Math.round))).toBeLessThan(load >= 24 ? 10_000 : 2_000);
  },
  60_000,
);
