import { expect, it } from "vitest";
import type { IngestProducer, StopStatus } from "@ace/media/ingest-sources";
import type { ScreenStreamSettings } from "@ace/protocol";
import { framePacket, FrameDecoder, type Frame } from "./frames.ts";
import { ScreenPictureSource } from "./picture-source.ts";

const viewer: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 960,
  maxHeight: 960,
  fps: 30,
  bitrate: 2_000_000,
};

function still(sequence: number): Frame {
  const frames: Frame[] = [];
  const payload = Buffer.from(`jpeg-${sequence}`);
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
  const pictures: string[] = [];
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
          picture: (base64) => {
            pictures.push(Buffer.from(base64, "base64").toString());
            return true;
          },
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
  return { source, producer: ready, pictures, encodes, sent, accepted, stalls };
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

it("a JPEG-only helper's pictures go to ace-media for a viewer, encoded inside the viewer's box", async () => {
  const s = session();
  expect(s.producer().origin).toEqual({ kind: "screen-pictures", platform: "windows" });
  expect(await s.source.configure(viewer)).toEqual({ codec: "h264" });
  // The helper keeps sending JPEG, at the viewer's rate.
  expect(s.sent.at(-1)).toMatchObject({
    op: "stream.configure",
    settings: { codec: "jpeg", fps: 30 },
  });
  // Nothing goes to ace-media before it holds the source.
  s.source.daemonFrame(still(1));
  expect(s.pictures).toEqual([]);
  await s
    .producer()
    .point({ url: "", socket: "", token: new Uint8Array(32), epoch: 1, path: "p1" });
  s.source.daemonFrame(still(2));
  expect(s.pictures).toEqual(["jpeg-2"]);
  expect(s.encodes.at(-1)).toEqual([
    { id: 1, codec: "avc1.42E033", width: 960, height: 540, fps: 30, bitrate: 2_000_000 },
  ]);
  // Its stills stay the session's, for agents.
  expect(s.accepted.map((f) => f.header.codec)).toEqual(["jpeg", "jpeg"]);
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
