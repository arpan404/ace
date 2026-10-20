import { describe, expect, it } from "vitest";
import type { BrowserCdp, CaptureEvents, VideoHost } from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { LiveVideo } from "./live-video.ts";
import type { BrowserAudioChunk } from "./stream-audio.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";

const page: BrowserCdp = { send: async () => ({}), on: () => {}, off: () => {} };

/** An encoder that records what it is told and lets the test play its output. */
function fakeHost() {
  const told: boolean[] = [];
  let events: CaptureEvents | undefined;
  let encode = "";
  const host: VideoHost = {
    supported: async () => ["avc1.42E033"],
    open: async (_page, _width, _height, capture) => {
      events = capture;
      return {
        encodes: (specs) => {
          encode = specs[0]?.key ?? "";
        },
        keyframe: () => {},
        audio: (on) => told.push(on),
        close: () => {},
      };
    },
  };
  return {
    host,
    told,
    sound(age: number, size = 40) {
      events?.audio?.({
        codec: "opus",
        sampleRate: 48_000,
        channels: 2,
        age,
        bytes: new Uint8Array(size),
      });
    },
    picture(age: number) {
      events?.chunk({
        encode,
        key: true,
        codec: "avc1.42E033",
        codedWidth: 1280,
        codedHeight: 800,
        bytes: new Uint8Array(10),
        age,
      });
    },
  };
}

const viewer = (audio: boolean, extra: Partial<CaptureViewer["viewport"]> = {}): CaptureViewer => ({
  viewport: { width: 640, height: 400, devicePixelRatio: 2, audio, ...extra },
  local: false,
  video: { codecs: ["avc1.42E033"] },
});

function sinks() {
  const audio: BrowserAudioChunk[] = [];
  const video: BrowserVideoChunk[] = [];
  return {
    audio,
    video,
    videoSink: { send: (chunk: BrowserVideoChunk) => (video.push(chunk), true) },
    audioSink: { send: (chunk: BrowserAudioChunk) => (audio.push(chunk), true) },
  };
}

/** A live capture with its encoder open: ticks until the fake host is probed and opened. */
async function live(clock: { now: number }) {
  const encoder = fakeHost();
  const video = new LiveVideo({ now: () => clock.now, playing: () => {} });
  video.attach({ host: encoder.host, page }, "tab-1", { width: 640, height: 400, scale: 1 });
  const settle = async () => {
    for (let index = 0; index < 4; index++) {
      video.tick({ width: 640, height: 400 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return { video, encoder, settle };
}

describe("page audio to viewers", () => {
  it("every viewer starts muted: the tab's sound isn't even encoded", async () => {
    const clock = { now: 1_000 };
    const { video, encoder, settle } = await live(clock);
    const phone = sinks();
    video.add("phone", phone.videoSink, viewer(false), phone.audioSink);
    await settle();
    encoder.sound(10);
    expect(encoder.told).toEqual([]);
    expect(phone.audio).toEqual([]);
  });

  it("a viewer that unmutes hears the page; a muted one beside it gets nothing", async () => {
    const clock = { now: 1_000 };
    const { video, encoder, settle } = await live(clock);
    const phone = sinks();
    const laptop = sinks();
    video.add("phone", phone.videoSink, viewer(false), phone.audioSink);
    video.add("laptop", laptop.videoSink, viewer(false), laptop.audioSink);
    await settle();
    video.configure("phone", viewer(true));
    await settle();
    expect(encoder.told).toEqual([true]);
    encoder.sound(10);
    encoder.sound(10);
    expect(phone.audio).toHaveLength(2);
    expect(phone.audio.map((chunk) => chunk.sequence)).toEqual([1, 2]);
    expect(phone.audio[0]).toMatchObject({ codec: "opus", sampleRate: 48_000, tabId: "tab-1" });
    expect(laptop.audio).toEqual([]);
  });

  it("the encoder stops once the last listener mutes or leaves", async () => {
    const clock = { now: 1_000 };
    const { video, encoder, settle } = await live(clock);
    const phone = sinks();
    const laptop = sinks();
    video.add("phone", phone.videoSink, viewer(true), phone.audioSink);
    video.add("laptop", laptop.videoSink, viewer(true), laptop.audioSink);
    await settle();
    video.configure("phone", viewer(false));
    await settle();
    // The laptop still listens.
    expect(encoder.told).toEqual([true]);
    video.remove("laptop");
    await settle();
    expect(encoder.told).toEqual([true, false]);
    encoder.sound(10);
    expect(phone.audio).toEqual([]);
  });

  it("a viewer whose native view covers the page doesn't listen", async () => {
    const clock = { now: 1_000 };
    const { video, encoder, settle } = await live(clock);
    const desktop = sinks();
    video.add("desktop", desktop.videoSink, viewer(true, { nativeShown: true }), desktop.audioSink);
    await settle();
    encoder.sound(10);
    expect(encoder.told).toEqual([]);
    expect(desktop.audio).toEqual([]);
  });

  it("sound and pictures are stamped when they were captured, on one clock", async () => {
    const clock = { now: 1_000 };
    const { video, encoder, settle } = await live(clock);
    const phone = sinks();
    video.add("phone", phone.videoSink, viewer(true), phone.audioSink);
    await settle();
    clock.now = 5_000;
    // A picture that took 40 ms to encode and a sound that took 70 ms (Opus buffers 20 ms
    // frames): both were captured at once, 4 960 ms, though the sound left the encoder later.
    encoder.picture(40);
    clock.now = 5_030;
    encoder.sound(70);
    expect(phone.audio[0]?.timestamp).toBe(4_960);
    expect(phone.video.at(-1)?.timestamp).toBe(4_960);
  });
});
