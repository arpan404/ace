import { expect, it } from "vitest";
import { encodeProducerStamp } from "@ace/media/producer-stamp";
import type { IngestProducer } from "@ace/media/ingest-sources";
import type { ScreenStreamSettings } from "@ace/protocol";
import { FrameDecoder, framePacket, wireFrame, type Frame } from "./frames.ts";
import { helperEncodesVideo } from "./helper-codecs.ts";
import { egressScreenFrame, ScreenMediaSource } from "./media-source.ts";

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
function session(platform = "macos", helperCodecs: string[] = ["jpeg", "h264"]) {
  let recording = false;
  const accepted: Frame[] = [];
  const replies: { ingest: "on" | "off"; boundary: number | null }[] = [];
  const sent: unknown[] = [];
  let producer: IngestProducer | undefined;
  const codecs: string[][] = [];
  const source = new ScreenMediaSource({
    sessionId: "s1",
    platform,
    codecs: helperCodecs,
    daemonNeedsVideo: () => recording,
    helper: {
      capabilities: undefined,
      permissions: async () => ({ screenRecording: true, accessibility: true }),
      requestV2: async () => ({}),
      request: async (command) => {
        if (command.op !== "stream.configure") return {};
        sent.push(command);
        const reply = replies.shift() ?? { ingest: "off", boundary: null };
        return { codec: command.settings.codec, ...reply, switched: true };
      },
    },
    media: {
      add: (added) => {
        producer = added;
        return {
          streaming: () => false,
          reconnect: () => {},
          codecs: (told) => void codecs.push([...told]),
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
  return {
    source,
    record: (on: boolean) => {
      recording = on;
    },
    accepted,
    replies,
    sent,
    codecs,
    producer: ready,
    video,
    still,
    egress,
    address,
  };
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

it.each(["macos", "windows", "linux-wayland"])(
  "a %s helper tells ace-media it encodes H.264 only, so no view is planned in HEVC",
  (platform) => {
    expect(session(platform).codecs).toEqual([["avc1.42E033"]]);
  },
);

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

it("ace-media's plan for the views it delivers reaches the helper, within its settings' bounds", async () => {
  const s = session();
  await s.source.configure(settings);
  s.producer().want?.([
    { id: 0, codec: "avc1.42E033", width: 1280, height: 800, fps: 15, bitrate: 600_000 },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.sent.at(-1)).toMatchObject({
    op: "stream.configure",
    settings: { codec: "h264", maxWidth: 1280, maxHeight: 800, fps: 15, bitrate: 600_000 },
  });
  // A thin link's plan below the helper's bounds is held to them, never refused.
  s.producer().want?.([
    { id: 0, codec: "avc1.42E033", width: 32, height: 20, fps: 5, bitrate: 50_000 },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(s.sent.at(-1)).toMatchObject({
    op: "stream.configure",
    settings: { codec: "h264", maxWidth: 64, maxHeight: 64, fps: 5, bitrate: 128_000 },
  });
});

it("a Linux helper is asked for H.264 only toward ace-media and keeps its JPEG pictures on the daemon's path", async () => {
  const s = session("linux-wayland");
  expect(s.producer().origin).toEqual({ kind: "screen", platform: "linux-wayland" });
  expect(await s.source.configure(settings)).toEqual({ codec: "jpeg" });
  expect(s.sent.at(-1)).toMatchObject({ settings: { ...settings, codec: "jpeg" } });
  expect(s.sent.at(-1)).not.toHaveProperty("ingest");
  expect(s.source.ingesting).toBe(false);
  // The route moves the screen to ace-media: the view's own H.264 request, with the address.
  s.replies.push({ ingest: "on", boundary: null });
  await s.producer().point(s.address("p1"));
  expect(s.sent.at(-1)).toMatchObject({ settings, ingest: { socket: "/run/m1i.sock" } });
  expect(s.source.ingesting).toBe(true);
  // No video ever went to the daemon's path, so ace-media's units are handed on at once.
  s.egress("p1", 4, true);
  s.egress("p1", 5);
  expect(order(s.accepted, "h264")).toEqual([4, 5]);
  // And back: JPEG pictures on the daemon's path again.
  await s.producer().point(undefined);
  expect(s.sent.at(-1)).toMatchObject({ settings: { ...settings, codec: "jpeg" } });
  expect(s.sent.at(-1)).not.toHaveProperty("ingest");
});

it("a Mac helper is asked for H.264 on either path", async () => {
  const s = session("macos");
  expect(await s.source.configure(settings)).toEqual({ codec: "h264" });
  expect(s.sent.at(-1)).toMatchObject({ settings });
});

const helper = (platform: string, codecs: ("jpeg" | "h264")[]) => ({ platform, codecs });

it("a helper streams its own video only where it encodes H.264: the Mac, Windows with a Media Foundation encoder, and Linux with an encoder that worked", () => {
  expect(helperEncodesVideo(helper("macos", ["jpeg", "h264"]))).toBe(true);
  expect(helperEncodesVideo(helper("windows", ["jpeg", "h264"]))).toBe(true);
  // No MFT: JPEG only, so the daemon's last-resort encoder makes the video.
  expect(helperEncodesVideo(helper("windows", ["jpeg"]))).toBe(false);
  expect(helperEncodesVideo(helper("linux-wayland", ["jpeg", "h264"]))).toBe(true);
  expect(helperEncodesVideo(helper("linux-wayland", ["jpeg"]))).toBe(false);
  expect(helperEncodesVideo(undefined)).toBe(false);
});

it("the helper is told which process serves ace-media's ingest, so it can refuse any other", async () => {
  const s = session();
  await s.source.configure(settings);
  s.replies.push({ ingest: "on", boundary: null });
  await s.producer().point({ ...s.address("p1"), pid: 4242 });
  expect(s.sent.at(-1)).toMatchObject({
    op: "stream.configure",
    ingest: { socket: "/run/m1i.sock", pid: 4242 },
  });
});

it("legacy viewers and ace-media's views share the helper's one stream, and neither overwrites the other", async () => {
  const s = session();
  const configured = () =>
    s.sent.flatMap((c) =>
      typeof c === "object" && c !== null && "settings" in c ? [c.settings] : [],
    );
  await s.source.configure({
    codec: "h264",
    maxWidth: 1280,
    maxHeight: 800,
    fps: 60,
    bitrate: 8_000_000,
  });
  s.producer().want?.([
    { id: 0, codec: "avc1.42E033", width: 1920, height: 1200, fps: 15, bitrate: 600_000 },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The stream both can take: the smaller of each.
  expect(configured().at(-1)).toEqual({
    codec: "h264",
    maxWidth: 1280,
    maxHeight: 800,
    fps: 15,
    bitrate: 600_000,
  });
  // A legacy viewer resizing keeps ace-media's lower rate.
  await s.source.configure({
    codec: "h264",
    maxWidth: 1024,
    maxHeight: 640,
    fps: 60,
    bitrate: 8_000_000,
  });
  expect(configured().at(-1)).toMatchObject({ maxWidth: 1024, fps: 15, bitrate: 600_000 });
  // ace-media's last view goes: the legacy viewer's request alone.
  s.producer().want?.([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(configured().at(-1)).toEqual({
    codec: "h264",
    maxWidth: 1024,
    maxHeight: 640,
    fps: 60,
    bitrate: 8_000_000,
  });
});

const hevcMain = "hvc1.1.6.L153.B0";
const hevcView = { id: 0, codec: hevcMain, width: 1280, height: 800, fps: 30, bitrate: 900_000 };
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastCodec = (sent: unknown[]) => {
  const last = sent.at(-1);
  if (typeof last !== "object" || last === null || !("settings" in last)) return undefined;
  const configured = last.settings;
  return typeof configured === "object" && configured !== null && "codec" in configured
    ? configured.codec
    : undefined;
};

it("a Mac helper whose hardware HEVC trial worked tells ace-media it encodes H.264 and HEVC, H.264 first", () => {
  expect(session("macos", ["jpeg", "h264", "hevc"]).codecs).toEqual([["avc1.42E033", hevcMain]]);
  // Only the Mac helper encodes HEVC toward ace-media.
  expect(session("windows", ["jpeg", "h264", "hevc"]).codecs).toEqual([["avc1.42E033"]]);
});

it("ace-media's plan in HEVC runs the Mac helper's stream in HEVC toward its ingest", async () => {
  const s = session("macos", ["jpeg", "h264", "hevc"]);
  s.replies.push({ ingest: "on", boundary: null });
  await s.producer().point(s.address("p1"));
  s.producer().want?.([hevcView]);
  await settled();
  expect(s.sent.at(-1)).toMatchObject({
    op: "stream.configure",
    settings: { codec: "hevc", maxWidth: 1280, maxHeight: 800, fps: 30, bitrate: 900_000 },
    ingest: { socket: "/run/m1i.sock" },
  });
  // Back on the daemon's socket, which carries H.264 only.
  await s.producer().point(undefined);
  await settled();
  expect(s.sent.at(-1)).not.toHaveProperty("ingest");
  expect(lastCodec(s.sent)).toBe("h264");
});

it("the shared stream stays H.264 while a legacy viewer watches, and turns HEVC when it leaves", async () => {
  const s = session("macos", ["jpeg", "h264", "hevc"]);
  await s.source.configure(settings);
  s.replies.push({ ingest: "on", boundary: null });
  await s.producer().point(s.address("p1"));
  s.producer().want?.([hevcView]);
  await settled();
  expect(lastCodec(s.sent)).toBe("h264");
  // The legacy viewer leaves (its JPEG request): ace-media's views alone, in HEVC, at their size.
  expect(await s.source.configure({ ...settings, codec: "jpeg" })).toEqual({ codec: "h264" });
  expect(s.sent.at(-1)).toMatchObject({ settings: { codec: "hevc", maxWidth: 1280, fps: 30 } });
  // A legacy viewer comes back: H.264 before its request returns.
  await s.source.configure(settings);
  expect(lastCodec(s.sent)).toBe("h264");
});

it("a recording keeps the shared stream H.264, since the daemon records the frames egress hands back", async () => {
  const s = session("macos", ["jpeg", "h264", "hevc"]);
  s.replies.push({ ingest: "on", boundary: null });
  await s.producer().point(s.address("p1"));
  s.producer().want?.([hevcView]);
  await settled();
  expect(lastCodec(s.sent)).toBe("hevc");
  s.record(true);
  await s.source.recodec();
  expect(lastCodec(s.sent)).toBe("h264");
  s.record(false);
  await s.source.recodec();
  expect(lastCodec(s.sent)).toBe("hevc");
});

it("an HEVC plan stays H.264 for a helper without HEVC, or while any view wants H.264", async () => {
  const plain = session("macos");
  plain.replies.push({ ingest: "on", boundary: null });
  await plain.producer().point(plain.address("p1"));
  plain.producer().want?.([hevcView]);
  await settled();
  expect(lastCodec(plain.sent)).toBe("h264");
  const mixed = session("macos", ["jpeg", "h264", "hevc"]);
  mixed.replies.push({ ingest: "on", boundary: null });
  await mixed.producer().point(mixed.address("p1"));
  mixed.producer().want?.([hevcView, { ...hevcView, id: 1, codec: "avc1.42E033", width: 640 }]);
  await settled();
  expect(lastCodec(mixed.sent)).toBe("h264");
});

it("an egress unit in HEVC is no frame for the daemon's H.264 consumers", () => {
  const unit = egressScreenFrame("s1", {
    kind: 1,
    flags: 1,
    ageUs: 0,
    width: 2,
    height: 2,
    displayWidth: 2,
    displayHeight: 2,
    scale: 1000,
    rotation: 0,
    codec: 3,
    encode: 0,
    epoch: 1,
    codecString: hevcMain,
    description: new Uint8Array(0),
    extension: encodeProducerStamp({ sequence: 1, timestamp: 1, scale: 1 }),
    payload: new Uint8Array(annexB),
  });
  expect(unit).toBeUndefined();
});
