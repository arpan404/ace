import { expect, it } from "vitest";
import { LatestFrameHub, type PortableFrame } from "@ace/screen/frames-client";
import {
  createDeviceRenderer,
  deviceStreamProfile,
  type DeviceRendererPorts,
  type DecodedDeviceFrame,
} from "./video-client.ts";

function frame(sequence: number, keyframe = false, codec: "h264" | "jpeg" = "h264"): PortableFrame {
  const bytes = new Uint8Array([1, 2, 3]);
  return {
    header: {
      version: 1,
      sessionId: "test",
      sequence,
      timestamp: sequence,
      width: 100,
      height: 200,
      codec,
      keyframe,
      bytes: 3,
      ...(keyframe ? { videoCodec: "avc1.42E01F" } : {}),
    },
    payload: bytes,
    packet: bytes,
  };
}
function fixture() {
  const drawn: number[] = [];
  const decoded: number[] = [];
  const images: number[] = [];
  let output: ((image: DecodedDeviceFrame) => void) | undefined;
  let fail: (() => void) | undefined;
  let keys = 0,
    fallbacks = 0,
    closes = 0,
    queue = 0;
  const ports: DeviceRendererPorts = {
    schedule: () => () => {},
    decoder: (_, onOutput, onError) => {
      output = onOutput;
      fail = onError;
      return {
        get decodeQueueSize() {
          return queue;
        },
        decode: (f) => decoded.push(f.header.version === 1 ? f.header.sequence : f.header.seq),
        close: () => {},
      };
    },
    video: (_, h) => drawn.push(h.version === 1 ? h.sequence : h.seq),
    image: async (f) => {
      images.push(f.header.version === 1 ? f.header.sequence : f.header.seq);
    },
    keyframe: () => keys++,
    fallback: () => fallbacks++,
    pressure: () => {},
  };
  return {
    ports,
    drawn,
    decoded,
    images,
    finish: () => output?.({ close: () => closes++ }),
    fail: () => fail?.(),
    queue: (n: number) => {
      queue = n;
    },
    get keys() {
      return keys;
    },
    get fallbacks() {
      return fallbacks;
    },
    get closes() {
      return closes;
    },
  };
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it("a blocked decoder retains the newest frame and resumes at an IDR after dropping dependants", async () => {
  const f = fixture();
  const render = createDeviceRenderer(f.ports);
  const hub = new LatestFrameHub<PortableFrame>();
  hub.subscribe(render.render);
  hub.publish(frame(0, true));
  await tick();
  for (let i = 1; i <= 20; i++) hub.publish(frame(i));
  expect(f.decoded).toEqual([0]);
  f.finish();
  await tick();
  expect(f.drawn).toEqual([0]);
  expect(f.keys).toBe(1);
  expect(f.decoded).toEqual([0]);
  hub.publish(frame(21));
  await tick();
  expect(f.keys).toBe(1);
  hub.publish(frame(22, true));
  await tick();
  f.finish();
  await tick();
  hub.publish(frame(23));
  await tick();
  f.finish();
  await tick();
  expect(f.drawn).toEqual([0, 22, 23]);
  expect(f.closes).toBe(3);
  render.close();
  hub.clear();
});
it("a decoder error negotiates image fallback once and displays JPEG frames", async () => {
  const f = fixture();
  const render = createDeviceRenderer(f.ports);
  const pending = render.render(frame(0, true));
  f.fail();
  await pending;
  await render.render(frame(1, true));
  expect(f.fallbacks).toBe(1);
  await render.render(frame(2, false, "jpeg"));
  expect(f.images).toEqual([2]);
  expect(f.drawn).toEqual([]);
  render.close();
});
it("an unavailable decoder requests JPEG without leaving a frame in flight", async () => {
  const f = fixture();
  f.ports.decoder = () => {
    throw new Error("unsupported");
  };
  const render = createDeviceRenderer(f.ports);
  await render.render(frame(0, true));
  await render.render(frame(1, false, "jpeg"));
  expect(f.fallbacks).toBe(1);
  expect(f.images).toEqual([1]);
  render.close();
});
it("closing a view releases decoding and ignores its late output", async () => {
  const f = fixture();
  const render = createDeviceRenderer(f.ports);
  const pending = render.render(frame(0, true));
  render.close();
  await pending;
  f.finish();
  expect(f.drawn).toEqual([]);
  expect(f.closes).toBe(1);
});
it("decoder overload discards deltas until a fresh keyframe arrives", async () => {
  const f = fixture();
  const render = createDeviceRenderer(f.ports);
  const first = render.render(frame(0, true));
  f.finish();
  await first;
  f.queue(2);
  await render.render(frame(1));
  await render.render(frame(2));
  expect(f.decoded).toEqual([0]);
  expect(f.keys).toBe(1);
  f.queue(0);
  const key = render.render(frame(3, true));
  f.finish();
  await key;
  expect(f.drawn).toEqual([0, 3]);
  render.close();
});
it("panel and network budgets reduce pixels and bitrate under pressure with JPEG fallback", () => {
  const small = deviceStreamProfile({ width: 350, height: 650 }, "local", true);
  expect(small.maxWidth).toBe(350);
  expect(small.maxHeight).toBe(650);
  expect(small.fps).toBe(60);
  const large = deviceStreamProfile({ width: 3000, height: 4000 }, "local", true);
  const relay = deviceStreamProfile({ width: 3000, height: 4000 }, "relay", true);
  const slow = deviceStreamProfile({ width: 3000, height: 4000 }, "relay", false, 2);
  expect(relay.maxWidth).toBeLessThan(large.maxWidth);
  expect(relay.bitrate).toBeLessThan(large.bitrate);
  expect(relay.fps).toBe(30);
  expect(slow.maxWidth).toBeLessThan(relay.maxWidth);
  expect(slow.bitrate).toBeLessThan(relay.bitrate);
  expect(slow.codec).toBe("jpeg");
});

it("a decoder that never produces pixels falls back instead of blocking the stream forever", async () => {
  const f = fixture();
  const deadline = Promise.withResolvers<() => void>();
  f.ports.schedule = (run) => {
    deadline.resolve(run);
    return () => {};
  };
  const render = createDeviceRenderer(f.ports);
  const pending = render.render(frame(0, true));
  (await deadline.promise)();
  await pending;
  expect(f.fallbacks).toBe(1);
  await render.render(frame(1, false, "jpeg"));
  expect(f.images).toEqual([1]);
  render.close();
});

it("a lost keyframe is requested again even when the source becomes idle", async () => {
  const f = fixture();
  let retry: (() => void) | undefined;
  f.ports.schedule = (run, ms) => {
    if (ms === 1000) retry = run;
    return () => {
      if (retry === run) retry = undefined;
    };
  };
  const render = createDeviceRenderer(f.ports);
  await render.render(frame(0));
  expect(f.keys).toBe(1);
  retry?.();
  expect(f.keys).toBe(2);
  const recovered = render.render(frame(1, true));
  f.finish();
  await recovered;
  retry?.();
  expect(f.keys).toBe(2);
  expect(f.drawn).toEqual([1]);
  render.close();
});
