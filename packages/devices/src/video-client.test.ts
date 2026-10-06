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
  const resources = new Set<object>();
  const outputs: ((image: DecodedDeviceFrame) => void)[] = [];
  const decoding = new Map<number, { promise: Promise<void>; resolve(): void }>();
  const waitDecoded = (sequence: number) => {
    if (decoded.includes(sequence)) return Promise.resolve();
    let waiter = decoding.get(sequence);
    if (!waiter) {
      waiter = Promise.withResolvers<void>();
      decoding.set(sequence, waiter);
    }
    return waiter.promise;
  };
  let output: ((image: DecodedDeviceFrame) => void) | undefined;
  let fail: ((reason?: "unsupported" | "decode") => void) | undefined;
  let keys = 0,
    fallbacks = 0,
    closes = 0,
    queue = 0;
  const ports: DeviceRendererPorts = {
    schedule: () => () => {},
    decoder: (_, onOutput, onError) => {
      output = onOutput;
      outputs.push(onOutput);
      const resource = {};
      resources.add(resource);
      fail = onError;
      return {
        get decodeQueueSize() {
          return queue;
        },
        decode: (f) => {
          if (!resources.has(resource)) throw new Error("Decoder disposed");
          const seq = f.header.version === 1 ? f.header.sequence : f.header.seq;
          decoded.push(seq);
          decoding.get(seq)?.resolve();
        },
        close: () => {
          resources.delete(resource);
        },
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
    resources,
    waitDecoded,
    late: (index: number) => outputs[index]?.({ close: () => closes++ }),
    finish: () => output?.({ close: () => closes++ }),
    fail: (reason: "unsupported" | "decode" = "unsupported") => fail?.(reason),
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
it("a blocked decoder retains the newest frame and resumes at an IDR after dropping dependants", async () => {
  const f = fixture();
  const render = createDeviceRenderer(f.ports);
  const hub = new LatestFrameHub<PortableFrame>();
  const completed = new Set<number>();
  const waiters = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const processed = (seq: number) => {
    if (completed.has(seq)) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    waiters.set(seq, waiter);
    return waiter.promise;
  };
  hub.subscribe(async (image) => {
    await render.render(image);
    const seq = image.header.version === 1 ? image.header.sequence : image.header.seq;
    completed.add(seq);
    waiters.get(seq)?.resolve();
  });
  hub.publish(frame(0, true));
  await f.waitDecoded(0);
  for (let i = 1; i <= 20; i++) hub.publish(frame(i));
  expect(f.decoded).toEqual([0]);
  f.finish();
  await processed(20);
  expect(f.drawn).toEqual([0]);
  expect(f.keys).toBe(1);
  expect(f.decoded).toEqual([0]);
  hub.publish(frame(21));
  await processed(21);
  expect(f.keys).toBe(1);
  hub.publish(frame(22, true));
  await f.waitDecoded(22);
  f.finish();
  await processed(22);
  hub.publish(frame(23));
  await f.waitDecoded(23);
  f.finish();
  await processed(23);
  expect(f.drawn).toEqual([0, 22, 23]);
  expect(f.closes).toBe(3);
  render.close();
  hub.clear();
  expect(f.resources.size).toBe(0);
});
it("an unsupported codec negotiates image fallback once and displays JPEG frames", async () => {
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
  expect(f.resources.size).toBe(0);
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

it("a stalled decoder drops its pending frame and recovers H.264 without negotiating JPEG", async () => {
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
  expect(f.fallbacks).toBe(0);
  expect(f.keys).toBe(1);
  const recovered = render.render(frame(1, true));
  f.finish();
  await recovered;
  expect(f.drawn).toEqual([1]);
  expect(f.images).toEqual([]);
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

it("resize and reconnect dispose the previous decoder and ignore its late output", async () => {
  const f = fixture();
  const render = createDeviceRenderer(f.ports);
  const old = render.render(frame(0, true));
  const resized = frame(1, true);
  resized.header = { ...resized.header, width: 200 };
  const next = render.render(resized);
  await old;
  expect(f.resources.size).toBe(1);
  f.late(0);
  expect(f.drawn).toEqual([]);
  f.finish();
  await next;
  expect(f.drawn).toEqual([1]);
  const reconnected = frame(0, true);
  reconnected.header = { ...reconnected.header, sessionId: "reconnected" };
  const first = render.render(reconnected);
  expect(f.resources.size).toBe(1);
  f.late(1);
  expect(f.drawn).toEqual([1]);
  f.finish();
  await first;
  expect(f.drawn).toEqual([1, 0]);
  render.close();
  expect(f.resources.size).toBe(0);
  expect(f.closes).toBe(4);
});

it("local decode pressure drops cadence without lowering the viewer's pixel density", () => {
  const panel = { width: 1051, height: 1951 };
  const stream = deviceStreamProfile(panel, "local", true, 3);
  expect(stream.maxWidth).toBe(1052);
  expect(stream.maxHeight).toBe(1952);
  expect(stream.fps).toBe(30);
  expect(stream.codec).toBe("h264");
});

it("a portrait viewer at DPR three keeps its full physical height", () => {
  expect(deviceStreamProfile({ width: 1440, height: 3300 }, "local", true)).toMatchObject({
    codec: "h264",
    maxWidth: 1440,
    maxHeight: 3300,
    fps: 60,
  });
});

it("a corrupt H.264 frame requests an IDR and resumes video without negotiating JPEG", async () => {
  const f = fixture();
  const render = createDeviceRenderer(f.ports);
  const first = render.render(frame(1, true));
  f.fail("decode");
  await first;
  expect(f.fallbacks).toBe(0);
  expect(f.keys).toBe(1);
  const next = render.render(frame(2, true));
  f.finish();
  await next;
  expect(f.drawn).toEqual([2]);
  expect(f.images).toEqual([]);
  render.close();
  expect(f.resources.size).toBe(0);
});

it("a synchronously rejected H.264 chunk recovers at an IDR without negotiating JPEG", async () => {
  const f = fixture();
  const decoder = f.ports.decoder;
  let rejected = false;
  f.ports.decoder = (...args) => {
    const port = decoder(...args);
    return {
      get decodeQueueSize() {
        return port.decodeQueueSize;
      },
      decode: (image) => {
        if (!rejected) {
          rejected = true;
          throw new Error("Invalid chunk");
        }
        port.decode(image);
      },
      close: () => port.close(),
    };
  };
  const render = createDeviceRenderer(f.ports);
  await render.render(frame(1, true));
  expect(f.fallbacks).toBe(0);
  expect(f.keys).toBe(1);
  const next = render.render(frame(2, true));
  f.finish();
  await next;
  expect(f.drawn).toEqual([2]);
  render.close();
  expect(f.resources.size).toBe(0);
});
