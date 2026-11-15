import { expect, test } from "vitest";
import type { BrowserCdp, CaptureEvents, VideoHost } from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { LiveVideo } from "./live-video.ts";
import type { VideoEncode } from "./video-policy.ts";

const page: BrowserCdp = { send: async () => ({}), on: () => {}, off: () => {} };

/** An encoder that records the encodes it is asked to run, and the capture's events. */
function host() {
  const encodes: VideoEncode[][] = [];
  const opened: CaptureEvents[] = [];
  const video: VideoHost = {
    supported: async () => ["avc1.42E033"],
    open: async (_page, _width, _height, events) => {
      opened.push(events);
      return {
        encodes: (specs) => encodes.push([...specs]),
        keyframe: () => {},
        close: () => {},
      };
    },
  };
  return { video, encodes, opened };
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
  video.add("main", { send: () => true }, pane, undefined, true);
  video.add("delivered", { send: () => true }, { ...pane, delivered: true });
  await ticks(video);
  encoder.opened[0]?.want?.([wanted]);
  await ticks(video);
  const last = encoder.encodes.at(-1) ?? [];
  expect(last).toContainEqual(wanted);
  expect(last.some((encode) => encode.key !== wanted.key)).toBe(true);
});
