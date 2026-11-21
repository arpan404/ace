import { expect, test } from "vitest";
import type { BrowserCdp, CaptureEvents, VideoHost } from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { LiveVideo } from "./live-video.ts";
import type { VideoEncode } from "./video-policy.ts";

const page: BrowserCdp = { send: async () => ({}), on: () => {}, off: () => {} };

/** An encoder that records the encodes it is asked to run, and the capture's events. */
function host(supported = ["avc1.42E033"]) {
  const encodes: VideoEncode[][] = [];
  const opened: CaptureEvents[] = [];
  const codecs: string[][] = [];
  const video: VideoHost = {
    mediaKind: "tab",
    supported: async () => supported,
    open: async (_page, _width, _height, events) => {
      opened.push(events);
      return {
        encodes: (specs) => encodes.push([...specs]),
        codecs: (told) => void codecs.push([...told]),
        keyframe: () => {},
        close: () => {},
      };
    },
  };
  return { video, encodes, opened, codecs };
}

const pane: CaptureViewer = {
  viewport: { width: 640, height: 400, devicePixelRatio: 1 },
  video: { codecs: ["avc1.42E033"] },
};

/** ace-media's plan for the views it delivers: one encode, small, on a thin link. */
const wanted: VideoEncode = {
  key: "media/0/avc1.42E033/320x200",
  codec: "avc1.42E033",
  width: 320,
  height: 200,
  fps: 15,
  bitrate: 150_000,
};

async function ticks(video: LiveVideo, count = 4) {
  for (let n = 0; n < count; n++) {
    video.tick({ width: 640, height: 400 });
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
  }
}

test("a view ace-media delivers keeps the capture, which then runs exactly what ace-media wants", async () => {
  const encoder = host();
  const video = new LiveVideo({ now: () => 1_000, playing: () => {} });
  video.attach({ host: encoder.video, page }, "tab-1", { width: 640, height: 400, scale: 1 });
  let sent = 0;
  const sink = {
    send: () => {
      sent++;
      return true;
    },
  };
  video.add("viewer", sink, { ...pane, delivered: true });
  await ticks(video);
  // The capture opened for it, before ace-media had a plan.
  const events = encoder.opened[0];
  if (!events) throw new Error("no capture opened");
  events.want?.([wanted]);
  await ticks(video);
  expect(encoder.encodes.at(-1)).toEqual([wanted]);
  // Its chunks go to ace-media, never to the daemon's sink for that view.
  events.chunk({
    encode: wanted.key,
    key: true,
    codec: wanted.codec,
    codedWidth: 320,
    codedHeight: 200,
    bytes: new Uint8Array(10),
  });
  await ticks(video, 1);
  expect(sent).toBe(0);
});

test("beside a viewer on the main socket, the capture runs the daemon's plan and ace-media's", async () => {
  const encoder = host();
  const video = new LiveVideo({ now: () => 1_000, playing: () => {} });
  video.attach({ host: encoder.video, page }, "tab-1", { width: 640, height: 400, scale: 1 });
  video.add("main", { send: () => true }, pane, undefined, { local: true });
  video.add("delivered", { send: () => true }, { ...pane, delivered: true });
  await ticks(video);
  encoder.opened[0]?.want?.([wanted]);
  await ticks(video);
  const last = encoder.encodes.at(-1) ?? [];
  expect(last).toContainEqual(wanted);
  expect(last.some((encode) => encode.key !== wanted.key)).toBe(true);
});

const hevc = "hvc1.1.6.L153.B0";

test("the capture tells ace-media the codecs its encoder runs, so it plans views only in those", async () => {
  const encoder = host([hevc, "avc1.42E033"]);
  const video = new LiveVideo({ now: () => 1_000, playing: () => {} });
  video.attach({ host: encoder.video, page }, "tab-1", { width: 640, height: 400, scale: 1 });
  video.add("phone", { send: () => true }, { ...pane, delivered: true });
  await ticks(video);
  expect(encoder.codecs).toEqual([[hevc, "avc1.42E033"]]);
});

test("an HEVC encode ace-media planned that fails is no longer offered to it, so the view gets H.264", async () => {
  const encoder = host([hevc, "avc1.42E033"]);
  const video = new LiveVideo({ now: () => 1_000, playing: () => {} });
  video.attach({ host: encoder.video, page }, "tab-1", { width: 640, height: 400, scale: 1 });
  video.add("phone", { send: () => true }, { ...pane, delivered: true });
  await ticks(video);
  const events = encoder.opened[0];
  if (!events) throw new Error("no capture opened");
  const planned = { ...wanted, key: `media/1/${hevc}/320x200`, codec: hevc };
  events.want?.([planned]);
  await ticks(video);
  events.failed(planned.key);
  await ticks(video);
  expect(encoder.codecs.at(-1)).toEqual(["avc1.42E033"]);
});
