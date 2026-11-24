import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MediaConnection, browserMediaSocket } from "@ace/client/media";
import { MediaSubscriptions, type MediaRoute } from "@ace/browser/live-view";
import { encodeMediaFrame } from "@ace/media/frame";
import type { IngestProducer } from "@ace/media/ingest-sources";
import type { MediaOwner } from "@ace/media/media-connections";
import { MediaRuntime } from "@ace/media/runtime";
import { nodeMediaHost, systemMediaClock } from "@ace/media/supervisor";
import { afterEach, expect, it } from "vitest";

/*
 * A device view's pictures, acknowledged by the client's own media route against the real
 * ace-media: the grant, the view, the fanout window and the codes its acks take. What a unit
 * test of either side can't show is that the client's acks (`MediaSubscriptions` deciding the
 * way, `MediaConnection` writing them) free the window ace-media holds the view to: a view
 * whose acks never arrive crawls at the window's size and then stops.
 */

const built = fileURLToPath(
  new URL("../../../native/media/target/debug/ace-media", import.meta.url),
);
const binary = process.env.ACE_MEDIA_TEST_BINARY?.trim() || (existsSync(built) ? built : undefined);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deviceId = "ios:03DDE173-AC85-410F-A152-21EDA18677F2";

/** One H.264 unit of the device's screen. */
const unit = (key: boolean, n: number) =>
  encodeMediaFrame({
    kind: 1,
    flags: key ? 1 : 0,
    ageUs: 0,
    width: 402,
    height: 874,
    displayWidth: 402,
    displayHeight: 874,
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

/** A device that streams into ace-media at 60 fps, a keyframe every 60 units. */
function device(): IngestProducer {
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    socket?.destroy();
    socket = undefined;
  };
  cleanups.push(stop);
  return {
    source: "simulator:acks",
    kind: "simulator",
    origin: {
      kind: "simulator",
      streamUrl: "http://127.0.0.1:1/stream.avcc",
      stillUrl: "http://127.0.0.1:1/x",
    },
    deviceId,
    epoch: () => 0,
    consumers: { deliver: () => {} },
    keyframe: () => {},
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
      timer = setInterval(() => connection.write(unit(n % 60 === 0, n++)), 16);
      return Promise.resolve();
    },
  };
}

const owner: MediaOwner = {
  session: "main-1",
  device: "phone",
  admission: { kind: "pairing", generation: "3f9a1c0e7b2d4a6c8e1f0b2d4c6e8a1f" },
};

async function watch(acks: boolean) {
  if (!binary) throw new Error("no ace-media binary");
  const runtimeDir = mkdtempSync(join(tmpdir(), "acem-acks-"));
  let ids = 0;
  const runtime = new MediaRuntime({
    version: execFileSync(binary, ["--version"]).toString().trim(),
    binary,
    runtimeDir,
    dataDir: runtimeDir,
    host: nodeMediaHost(process.env),
    clock: systemMediaClock,
    random: Math.random,
    listen: () => ({ message: { type: "listen", loopback: true }, payload: new Uint8Array(0) }),
    id: () => `id-${++ids}`,
    capabilities: { ingest: ["simulator"], delivery: true },
    log: () => {},
  });
  cleanups.push(() => {
    runtime.dispose();
    rmSync(runtimeDir, { recursive: true, force: true });
  });
  const source = runtime.sources.add(device());
  for (let i = 0; i < 500 && !source.streaming(); i++) await wait(10);
  if (!source.streaming()) throw new Error("the device never streamed");
  const grant = await runtime.connections.connect(owner);
  if (!grant.ok) throw new Error(grant.code);

  const connection = new MediaConnection({
    connect: async () => ({ type: "media.connect.result", requestId: "grant", result: grant }),
    socket: browserMediaSocket,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      cleanups.push(() => clearTimeout(timer));
      return () => clearTimeout(timer);
    },
    now: () => performance.now(),
  });
  cleanups.push(() => connection.stop());
  const route: MediaRoute = {
    binding: () => connection.binding(),
    codecs: () => ["avc1.42E033"],
    watch: (listener) => connection.watch(listener),
    onStream: (listener) => connection.onStream(listener),
    ack: (message) => connection.ack(message),
  };
  const subscriptions = new MediaSubscriptions();
  subscriptions.use(route);
  const sequences: number[] = [];
  connection.onStream((message) => {
    if (message.kind !== "device.frame" || message.frame.still) return;
    const binding = route.binding()?.connection;
    if (!binding) return;
    const stamped = subscriptions.arrive(deviceId, binding, message.frame);
    if (!stamped) return;
    sequences.push(message.frame.sequence);
    if (!acks) return;
    const picture = { ...stamped.frame, sourceId: deviceId, generation: stamped.generation };
    // What the client does when its decoder shows a picture (`DeviceClient.ack`).
    if (subscriptions.way(deviceId, picture.generation) === "media")
      route.ack({
        type: "devices.ack",
        deviceId,
        streamId: picture.streamId,
        sequence: picture.sequence,
      });
  });
  connection.start();
  for (let i = 0; i < 300 && !connection.binding(); i++) await wait(10);
  const binding = connection.binding();
  if (!binding) throw new Error("no media connection");
  const subscribe = subscriptions.begin(deviceId);
  const viewer = runtime.viewers.bind({
    requester: owner,
    connection: binding.connection,
    target: { kind: "device", deviceId },
    codecs: ["avc1.42E033"],
    viewport: { width: 402, height: 874, dpr: 3, scale: 1 },
    local: true,
    audio: false,
    shows: (producer) => producer.deviceId === deviceId,
  });
  if (!viewer) throw new Error("the view was not opened");
  subscriptions.subscribed(deviceId, subscribe.generation, { connection: binding.connection });
  return sequences;
}

/** Pictures received in `ms` after the view is settled. */
async function flow(sequences: number[], ms: number): Promise<number> {
  const before = sequences.length;
  await wait(ms);
  return sequences.length - before;
}

it.skipIf(!binary)(
  "a device view's acks from the client's own media route free ace-media's window: it keeps sending every picture",
  async () => {
    const sequences = await watch(true);
    // The window is 60 pictures: without its acks reaching ace-media the view stalls at about
    // that many and then only takes the source's own keyframes (one a second). Sixty a second
    // is the window moving.
    await flow(sequences, 1_000);
    const flowing = await flow(sequences, 2_000);
    expect(flowing).toBeGreaterThan(90);
    // The pictures it is getting now are consecutive: the acks free each one's chunk.
    const tail = sequences.slice(-60);
    let previous: number | undefined;
    const gaps = tail.filter((sequence) => {
      const gap = previous !== undefined && sequence !== previous + 1;
      previous = sequence;
      return gap;
    });
    expect(gaps).toEqual([]);
  },
);

it.skipIf(!binary)("a device view that never acks stalls at ace-media's window", async () => {
  const sequences = await watch(false);
  // The failure the acks prevent: the window fills, and all that comes after is the source's
  // own keyframe, about one a second.
  await flow(sequences, 2_500);
  const flowing = await flow(sequences, 2_000);
  expect(flowing).toBeLessThanOrEqual(5);
  expect(sequences.length).toBeLessThan(70);
});
