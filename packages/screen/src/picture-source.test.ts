import { expect, it, onTestFinished } from "vitest";
import type { IngestProducer, StopStatus } from "@ace/media/ingest-sources";
import type { ScreenStreamSettings } from "@ace/protocol";
import { framePacket, FrameDecoder, type Frame } from "./frames.ts";
import { maxStillPictureBytes as maxPictureBytes } from "@ace/media/ingest-writer";
import { ingestServer, until } from "@ace/media/testing/ingest-server";
import { ScreenPictureSource } from "./picture-source.ts";

async function ingest() {
  const server = await ingestServer();
  onTestFinished(server.close);
  return server;
}

const viewer: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 960,
  maxHeight: 960,
  fps: 30,
  bitrate: 2_000_000,
};

function still(sequence: number, bytes?: number): Frame {
  const frames: Frame[] = [];
  const payload =
    bytes === undefined ? Buffer.from(`jpeg-${sequence}`) : Buffer.alloc(bytes, sequence);
  new FrameDecoder((frame) => void frames.push(frame)).push(
    framePacket(
      {
        version: 2,
        sessionId: "s1",
        seq: sequence,
        ts: sequence,
        width: 1920,
        height: 1080,
        scale: 2,
        codec: "jpeg",
        bytes: payload.length,
      },
      payload,
    ),
  );
  const [frame] = frames;
  if (!frame) throw new Error("no frame");
  return frame;
}

/** A JPEG-only helper's session, with ace-media at its edge. */
function session() {
  let producer: IngestProducer | undefined;
  const encodes: unknown[] = [];
  const sent: unknown[] = [];
  const accepted: Frame[] = [];
  const stalls: ({ status: StopStatus; reason: string } | undefined)[] = [];
  const source = new ScreenPictureSource({
    sessionId: "s1",
    platform: "windows",
    helper: {
      capabilities: undefined,
      permissions: async () => ({ screenRecording: true, accessibility: true }),
      requestV2: async () => ({}),
      request: async (command) => {
        sent.push(command);
        return { codec: "jpeg" };
      },
    },
    media: {
      add: (added) => {
        producer = added;
        return {
          streaming: () => true,
          reconnect: () => {},
          codecs: () => {},
          encodes: (next) => void encodes.push(next),
          key: () => {},
          close: () => {},
        };
      },
    },
    accept: (frame) => void accepted.push(frame),
    stalled: (status) => void stalls.push(status),
    now: () => 5_000,
  });
  const ready = () => {
    if (!producer) throw new Error("no producer");
    return producer;
  };
  return { source, producer: ready, encodes, sent, accepted, stalls };
}

/** A real avcC (one SPS, one PPS), and an IDR as ace-media's encoder writes it: AVCC. */
const avcc = Uint8Array.from(
  Buffer.from("01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0", "hex"),
);
const sps = [...Buffer.from("27640033ac13143c04c0149e6a9a81010103c20108f8", "hex")];
const pps = [...Buffer.from("28ee3cb0", "hex")];
const idr = Uint8Array.from([0, 0, 0, 3, 0x65, 0x88, 0x01]);

const unit = (path: string, keyframe: boolean) => ({
  source: path,
  sequence: 0,
  gap: false,
  frame: {
    kind: 1,
    flags: keyframe ? 5 : 0,
    ageUs: 0,
    width: 960,
    height: 540,
    displayWidth: 960,
    displayHeight: 540,
    scale: 1000,
    rotation: 0,
    codec: 2,
    encode: 1,
    epoch: 1,
    codecString: "avc1.42E033",
    description: keyframe ? avcc : new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: keyframe ? idr : Uint8Array.from([0, 0, 0, 2, 0x41, 0x9a]),
  },
});

const point = (s: ReturnType<typeof session>, socket: string) =>
  s.producer().point({ url: "", socket, token: new Uint8Array(32).fill(4), epoch: 1, path: "p1" });

it("a JPEG-only helper's pictures go to ace-media's ingest as binary still pictures, never on the control lane", async () => {
  const s = session();
  const server = await ingest();
  expect(s.producer().origin).toEqual({ kind: "screen-pictures", platform: "windows" });
  expect(await s.source.configure(viewer)).toEqual({ codec: "h264" });
  // The helper keeps sending JPEG, at the viewer's rate.
  expect(s.sent.at(-1)).toMatchObject({
    op: "stream.configure",
    settings: { codec: "jpeg", fps: 30 },
  });
  // Nothing goes to ace-media before it holds the source.
  s.source.daemonFrame(still(1));
  await point(s, server.path);
  s.source.daemonFrame(still(2));
  await until(() => server.received.length >= 2);
  const [hello, picture] = server.received;
  expect(hello?.kind).toBe(5);
  expect(picture).toMatchObject({ kind: 3, codec: 7, flags: 1, width: 1920, height: 1080 });
  expect(Buffer.from(picture?.payload ?? []).toString()).toBe("jpeg-2");
  expect(s.encodes.at(-1)).toEqual([
    { id: 1, codec: "avc1.42E033", width: 960, height: 540, fps: 30, bitrate: 2_000_000 },
  ]);
  // Its stills stay the session's, for agents.
  expect(s.accepted.map((f) => f.header.codec)).toEqual(["jpeg", "jpeg"]);
});

it("a picture too large for ace-media is dropped and counted, and the session goes on", async () => {
  const s = session();
  const server = await ingest();
  await s.source.configure(viewer);
  await point(s, server.path);
  // The helper's own header caps a picture at ace-media's limit; one past it is built here.
  const huge = still(1);
  s.source.daemonFrame({ ...huge, payload: Buffer.alloc(maxPictureBytes + 1) });
  s.source.daemonFrame(still(2));
  await until(() => server.received.length >= 2);
  expect(s.source.dropped).toBe(1);
  expect(server.received.filter((f) => f.kind === 3).map((f) => f.payload.length)).toEqual([6]);
  expect(s.accepted).toHaveLength(2);
});

it("while ace-media reads slowly only the newest picture waits: the queue never grows with the helper", async () => {
  const s = session();
  const server = await ingest();
  await s.source.configure(viewer);
  await point(s, server.path);
  await until(server.connected);
  server.pause();
  // Pictures far past the writer's budget arrive while ace-media isn't reading.
  for (let n = 1; n <= 40; n++) s.source.daemonFrame(still(n, 512 * 1024));
  server.resume();
  await until(() => server.received.some((f) => f.kind === 3 && f.payload[0] === 40));
  const pictures = server.received.filter((f) => f.kind === 3);
  expect(pictures.length).toBeLessThan(40);
  expect(pictures.at(-1)?.payload[0]).toBe(40);
});

it("closing the session sends its last picture and its ingest end, rather than cutting them", async () => {
  const s = session();
  const server = await ingest();
  await s.source.configure(viewer);
  await point(s, server.path);
  await until(server.connected);
  server.pause();
  for (let n = 1; n <= 12; n++) s.source.daemonFrame(still(n, 512 * 1024));
  s.source.close();
  server.resume();
  await until(() => server.received.some((f) => f.kind === 4));
  expect(server.received.findLast((f) => f.kind === 3)?.payload[0]).toBe(12);
  expect(server.received.at(-1)?.kind).toBe(4);
});

it("ace-media's plan for the views it delivers runs as its own encodes and sets the helper's pictures", async () => {
  const s = session();
  s.producer().want?.([
    { id: 9, codec: "avc1.42E033", width: 640, height: 360, fps: 15, bitrate: 600_000 },
  ]);
  expect(s.encodes.at(-1)).toEqual([
    { id: 9, codec: "avc1.42E033", width: 640, height: 360, fps: 15, bitrate: 600_000 },
  ]);
  await until(() => s.sent.length > 0);
  expect(s.sent.at(-1)).toMatchObject({
    op: "stream.configure",
    settings: { codec: "jpeg", maxWidth: 640, maxHeight: 360, fps: 15 },
  });
});

it("ace-media's encode comes back as the session's H.264, Annex B with its parameter sets on the keyframe", async () => {
  const s = session();
  await s.source.configure(viewer);
  s.source.daemonFrame(still(1));
  s.producer().consumers.deliver(unit("p1", true));
  s.producer().consumers.deliver(unit("p1", false));
  const [key, delta] = s.accepted.filter((f) => f.header.codec === "h264");
  expect(key?.header).toMatchObject({
    codec: "h264",
    keyframe: true,
    width: 960,
    height: 540,
    scale: 1,
  });
  expect([...(key?.payload ?? [])]).toEqual([
    0,
    0,
    0,
    1,
    ...sps,
    0,
    0,
    0,
    1,
    ...pps,
    0,
    0,
    0,
    1,
    0x65,
    0x88,
    0x01,
  ]);
  expect([...(delta?.payload ?? [])]).toEqual([0, 0, 0, 1, 0x41, 0x9a]);
});

it("an encoder that can't run says why; ace-media restarting says so too, and the next picture clears it", async () => {
  const s = session();
  await s.source.configure(viewer);
  s.source.daemonFrame(still(1));
  s.producer().stopped?.("no encoder works here: the last-resort encoder failed", "unavailable");
  expect(s.stalls.at(-1)).toEqual({
    status: "unavailable",
    reason: "no encoder works here: the last-resort encoder failed",
  });
  s.producer().stopped?.("ace-media stopped and is starting again", "retrying");
  expect(s.stalls.at(-1)?.status).toBe("retrying");
  s.producer().consumers.deliver(unit("p2", true));
  expect(s.stalls.at(-1)).toBeUndefined();
});
