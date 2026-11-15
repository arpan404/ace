import { expect, it } from "vitest";
import { encodeProducerStamp } from "@ace/media/producer-stamp";
import type { IngestProducer } from "@ace/media/ingest-sources";
import type { ScreenStreamSettings } from "@ace/protocol";
import { FrameDecoder, framePacket, wireFrame, type Frame } from "./frames.ts";
import { egressScreenFrame, helperEncodesVideo, ScreenMediaSource } from "./media-source.ts";

const settings: ScreenStreamSettings = {
  codec: "h264",
  maxWidth: 1280,
  maxHeight: 1280,
  fps: 30,
  bitrate: 2_000_000,
};

const annexB = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x33, 0, 0, 0, 1, 0x65, 0x88]);

/** What the helper's socket carries for one keyframe today. */
function fromHelperSocket(): Frame {
  const frames: Frame[] = [];
  new FrameDecoder((frame) => void frames.push(frame)).push(
    framePacket(
      {
        version: 2,
        sessionId: "s1",
        seq: 41,
        ts: 1_763_000_000_123.5,
        width: 1280,
        height: 800,
        scale: 1.7777,
        codec: "h264",
        keyframe: true,
        videoCodec: "avc1.640033",
        bytes: annexB.length,
      },
      annexB,
    ),
  );
  const [frame] = frames;
  if (!frame) throw new Error("no frame");
  return frame;
}

it("an egress unit becomes the frame the helper socket carries, header and packet alike", () => {
  const frame = egressScreenFrame("s1", {
    kind: 1,
    flags: 1,
    ageUs: 1500,
    width: 1280,
    height: 800,
    displayWidth: 720,
    displayHeight: 450,
    scale: 1778,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 1,
    codecString: "avc1.640033",
    description: new Uint8Array(0),
    extension: encodeProducerStamp({ sequence: 41, timestamp: 1_763_000_000_123.5, scale: 1.7777 }),
    payload: new Uint8Array(annexB),
  });
  const expected = fromHelperSocket();
  expect(frame?.header).toEqual(expected.header);
  expect(frame?.payload).toEqual(expected.payload);
  expect(frame?.packet).toEqual(expected.packet);
});

it("an egress unit without the helper's stamp, or not H.264, is no screen frame", () => {
  const base = {
    kind: 1,
    flags: 0,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: 1,
    encode: 0,
    epoch: 1,
    codecString: "",
    description: new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array(annexB),
  };
  expect(egressScreenFrame("s1", base)).toBeUndefined();
  const stamped = {
    ...base,
    extension: encodeProducerStamp({ sequence: 1, timestamp: 1, scale: 1 }),
  };
  expect(egressScreenFrame("s1", { ...stamped, codec: 7 })).toBeUndefined();
  expect(egressScreenFrame("s1", stamped)?.header.keyframe).toBe(false);
});

/** A screen session's media source with a scripted helper and a stand-in for ace-media. */
function session() {
  const accepted: Frame[] = [];
  const replies: { ingest: "on" | "off"; boundary: number | null }[] = [];
  let producer: IngestProducer | undefined;
  const source = new ScreenMediaSource({
    sessionId: "s1",
    platform: "macos",
    helper: {
      capabilities: undefined,
      permissions: async () => ({ screenRecording: true, accessibility: true }),
      requestV2: async () => ({}),
      request: async (command) => {
        if (command.op !== "stream.configure") return {};
        const reply = replies.shift() ?? { ingest: "off", boundary: null };
        return { codec: "h264", ...reply, switched: true };
      },
    },
    media: {
      add: (added) => {
        producer = added;
        return {
          streaming: () => false,
          reconnect: () => {},
          encodes: () => {},
          key: () => {},
          picture: () => false,
          close: () => {},
        };
      },
    },
    accept: (handed) => void accepted.push(handed),
    schedule: () => () => {},
  });
  const ready = () => {
    if (!producer) throw new Error("no producer");
    return producer;
  };
  const egress = (path: string, sequence: number, keyframe = false) =>
    ready().consumers.deliver({
      source: path,
      sequence,
      gap: false,
      frame: {
        kind: 1,
        flags: keyframe ? 1 : 0,
        ageUs: 0,
        width: 2,
        height: 2,
        displayWidth: 2,
        displayHeight: 2,
        scale: 1000,
        rotation: 0,
        codec: 1,
        encode: 0,
        epoch: 1,
        codecString: keyframe ? "avc1.640033" : "",
        description: new Uint8Array(0),
        extension: encodeProducerStamp({ sequence, timestamp: sequence, scale: 1 }),
        payload: new Uint8Array(annexB),
      },
    });
  return { source, accepted, replies, producer: ready, video, still, egress, address };
}

const video = (sequence: number, keyframe = false) => screenFrame(sequence, "h264", keyframe);
const still = (sequence: number) => screenFrame(sequence, "jpeg", true);
const address = (path: string) => ({
  url: "ws://127.0.0.1:1/ingest",
  socket: "/run/m1i.sock",
  token: new Uint8Array(32).fill(1),
  epoch: 1,
  path,
});

function screenFrame(sequence: number, codec: "h264" | "jpeg", keyframe: boolean): Frame {
  return wireFrame(
    {
      version: 2,
      sessionId: "s1",
      seq: sequence,
      ts: sequence,
      width: 2,
      height: 2,
      scale: 1,
      codec,
      keyframe,
      bytes: annexB.length,
    },
    annexB,
  );
}

const order = (frames: Frame[], codec: "h264" | "jpeg") =>
  frames.filter((f) => f.header.codec === codec).map((f) => f.header.sequence);

it("a still on the helper socket during a switch into ace-media neither waits for nor drops the held video", async () => {
  const s = session();
  await s.source.configure(settings);
  s.source.daemonFrame(s.video(1, true));
  s.source.daemonFrame(s.video(2));
  s.replies.push({ ingest: "on", boundary: 3 });
  await s.producer().point(s.address("p1"));
  // ace-media's path is faster than the helper socket: its keyframe overtakes delta 3.
  s.egress("p1", 4, true);
  s.egress("p1", 5);
  // A still (stills always take the helper socket) with a sequence past the held video.
  s.source.daemonFrame(s.still(6));
  s.source.daemonFrame(s.video(3));
  s.egress("p1", 7);
  expect(order(s.accepted, "h264")).toEqual([1, 2, 3, 4, 5, 7]);
  expect(order(s.accepted, "jpeg")).toEqual([6]);
  expect(s.source.stale).toBe(0);
});

it("a flip back to the helper socket while ace-media still has the old path's units loses and repeats nothing", async () => {
  const s = session();
  await s.source.configure(settings);
  s.replies.push({ ingest: "on", boundary: null });
  await s.producer().point(s.address("p1"));
  s.egress("p1", 1, true);
  s.egress("p1", 2);
  // The route moves back while units 3..5 are still queued on the old connection and in
  // ace-media: the helper's new keyframe on its own socket arrives first.
  s.replies.push({ ingest: "off", boundary: 5 });
  await s.producer().point(undefined);
  s.source.daemonFrame(s.video(6, true));
  s.source.daemonFrame(s.video(7));
  s.egress("p1", 3);
  s.egress("p1", 4);
  s.egress("p1", 5);
  expect(order(s.accepted, "h264")).toEqual([1, 2, 3, 4, 5]);
  // ace-media's end marker, after the path's last unit: the held frames follow in order.
  s.producer().pathEnded?.("p1", false);
  s.source.daemonFrame(s.video(8));
  expect(order(s.accepted, "h264")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(s.source.stale).toBe(0);
});

const helper = (platform: string, codecs: ("jpeg" | "h264")[]) => ({ platform, codecs });

it("a helper streams its own video only where it encodes H.264: the Mac, and Windows with a Media Foundation encoder", () => {
  expect(helperEncodesVideo(helper("macos", ["jpeg", "h264"]))).toBe(true);
  expect(helperEncodesVideo(helper("windows", ["jpeg", "h264"]))).toBe(true);
  // No MFT: JPEG only, so the daemon's last-resort encoder makes the video.
  expect(helperEncodesVideo(helper("windows", ["jpeg"]))).toBe(false);
  expect(helperEncodesVideo(helper("linux-wayland", ["jpeg", "h264"]))).toBe(false);
  expect(helperEncodesVideo(undefined)).toBe(false);
});
