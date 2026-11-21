import { describe, expect, it } from "vitest";
import type { EgressUnit } from "@ace/media/egress";
import type { MediaFrame } from "@ace/media/frame";
import type { IngestAddress, IngestProducer } from "@ace/media/ingest-sources";
import type {
  BrowserCdp,
  CaptureEvents,
  EncodedChunk,
  VideoCaptureHandle,
  VideoHost,
  VideoIngestTarget,
  VideoMediaKind,
} from "./backend.ts";
import { mediaMissing, mediaVideoHost, noMedia, type BrowserMedia } from "./media-video.ts";
import type { VideoEncode } from "./video-policy.ts";

const page = {} as BrowserCdp;

function frame(encode: number, key: boolean, payload: number): MediaFrame {
  return {
    kind: 1,
    flags: key ? 5 : 0,
    ageUs: 4_000,
    width: 640,
    height: 400,
    displayWidth: 640,
    displayHeight: 400,
    scale: 1000,
    rotation: 0,
    codec: 2,
    encode,
    epoch: 0,
    codecString: "avc1.640020",
    description: key ? new Uint8Array([1, 0x64, 0, 0x20]) : new Uint8Array(0),
    extension: new Uint8Array(0),
    payload: new Uint8Array([payload]),
  };
}

const unit = (path: string, f: MediaFrame): EgressUnit => ({
  source: path,
  frame: f,
  sequence: 0,
  gap: false,
});

const address = (path: string): IngestAddress => ({
  url: "ws://127.0.0.1:9/ingest",
  socket: "",
  token: new Uint8Array(32).fill(7),
  epoch: 3,
  path,
});

/** ace-media at the browser's edge: each `add` records the producer and what it was told. */
function fakeMedia(state: { routed: boolean; wanted?: boolean; codecs?: string[] }) {
  const added: {
    producer: IngestProducer;
    encodes: unknown[];
    codecs: string[][];
    pictures: string[];
    keys: number[];
    reconnects: number;
    closed: boolean;
  }[] = [];
  const media: BrowserMedia = {
    add: (producer) => {
      const record = {
        producer,
        encodes: [],
        codecs: [],
        pictures: [],
        keys: [],
        reconnects: 0,
        closed: false,
      } as (typeof added)[number];
      added.push(record);
      return {
        streaming: () => state.routed,
        encodes: (encodes) => void record.encodes.push(encodes),
        codecs: (codecs) => void record.codecs.push([...codecs]),
        key: (encode) => void record.keys.push(encode),
        reconnect: () => void record.reconnects++,
        picture: (base64) => {
          record.pictures.push(base64);
          return true;
        },
        close: () => {
          record.closed = true;
        },
      };
    },
    routed: () => state.routed,
    wanted: () => state.wanted ?? state.routed,
    pictureCodecs: () => state.codecs ?? ["avc1.640020"],
    endpoint: () => (state.routed ? "ws://127.0.0.1:9/ingest" : undefined),
  };
  return { media, added };
}

/** A backend's host whose captures record what they were told and can emit as the encoder. */
function fakeHost(kind: VideoMediaKind, ingest: boolean) {
  const captures: {
    encodes: VideoEncode[][];
    targets: (VideoIngestTarget | undefined)[];
    pictures: string[];
    closed: boolean;
    events: CaptureEvents;
  }[] = [];
  const host: VideoHost = {
    mediaKind: kind,
    supported: (codecs) => Promise.resolve([...codecs]),
    open: (_page, width, height, sink) => {
      const capture = {
        encodes: [],
        targets: [],
        pictures: [],
        closed: false,
        events: sink,
      } as (typeof captures)[number];
      captures.push(capture);
      const handle: VideoCaptureHandle = {
        encodes: (specs) => void capture.encodes.push([...specs]),
        keyframe: () => {},
        pictures: { width, height, push: (data) => void capture.pictures.push(data) },
        close: () => {
          capture.closed = true;
        },
        ...(ingest
          ? { ingest: (target: VideoIngestTarget | undefined) => void capture.targets.push(target) }
          : {}),
      };
      return Promise.resolve(handle);
    },
  };
  return { host, captures };
}

function events() {
  const chunks: EncodedChunk[] = [];
  const ended: (string | undefined)[] = [];
  const failed: string[] = [];
  const sink: CaptureEvents = {
    chunk: (chunk) => void chunks.push(chunk),
    failed: (encode) => void failed.push(encode),
    ended: (reason) => void ended.push(reason),
  };
  return { chunks, ended, failed, sink };
}

const spec = (key: string): VideoEncode => ({
  key,
  codec: "avc1.42E033",
  width: 640,
  height: 400,
  fps: 60,
  bitrate: 4_000_000,
});

const marks = (chunks: EncodedChunk[]) => chunks.map((chunk) => chunk.bytes[0]);

describe("live video routed through ace-media", () => {
  it.each(["tab", "tab-pictures"] as const)(
    "a %s capture tells ace-media the codecs its encoder runs",
    async (kind) => {
      const { media, added } = fakeMedia({ routed: true, codecs: ["hvc1.1.6.L153.B0"] });
      const { host } = fakeHost(kind, true);
      const handle = await mediaVideoHost(host, media, () => ({})).open(
        page,
        640,
        400,
        events().sink,
      );
      handle.codecs?.(["hvc1.1.6.L153.B0", "avc1.42E033"]);
      expect(added.map((record) => record.codecs)).toEqual([[["hvc1.1.6.L153.B0", "avc1.42E033"]]]);
    },
  );

  it("a tab's own encoder is pointed at the ingest with its token, and egress units reach the capture as its chunks", async () => {
    const { media, added } = fakeMedia({ routed: true });
    const { host, captures } = fakeHost("tab", true);
    const e = events();
    const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, e.sink);
    const producer = added[0]?.producer;
    await producer?.point(address("m1"));
    expect(captures[0]?.targets).toEqual([
      { url: "ws://127.0.0.1:9/ingest", token: Buffer.alloc(32, 7).toString("base64"), epoch: 3 },
    ]);
    handle.encodes([spec("avc1/640"), spec("avc1/320")]);
    // The daemon's own encodes take ids above ace-media's, which start at 1 (D1).
    expect(captures[0]?.encodes[0]?.map((s) => s.id)).toEqual([2 ** 20, 2 ** 20 + 1]);
    producer?.consumers.deliver(unit("m1", frame(2 ** 20 + 1, true, 9)));
    producer?.consumers.deliver(unit("m1", frame(2 ** 20 + 1, false, 10)));
    producer?.consumers.deliver(unit("m1", frame(77, false, 11)));
    expect(e.chunks).toEqual([
      expect.objectContaining({
        encode: "avc1/320",
        key: true,
        codec: "avc1.640020",
        age: 4,
        description: new Uint8Array([1, 0x64, 0, 0x20]),
      }),
      expect.objectContaining({ encode: "avc1/320", key: false }),
    ]);
    expect(e.chunks[1]).not.toHaveProperty("description");
    handle.close();
    expect(added[0]?.closed).toBe(true);
    expect(captures[0]?.closed).toBe(true);
  });

  it("a reopened path's keyframe waits for the old path's late deltas and its end marker", async () => {
    const { media, added } = fakeMedia({ routed: true });
    const { host } = fakeHost("tab", true);
    const e = events();
    const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, e.sink);
    handle.encodes([spec("avc1/640")]);
    const producer = added[0]?.producer;
    await producer?.point(address("m1"));
    producer?.consumers.deliver(unit("m1", frame(2 ** 20, true, 1)));
    // ace-media reopened the source: the new path's keyframe overtakes the old one's deltas.
    await producer?.point(address("m2"));
    producer?.consumers.deliver(unit("m2", frame(2 ** 20, true, 4)));
    producer?.consumers.deliver(unit("m1", frame(2 ** 20, false, 2)));
    producer?.consumers.deliver(unit("m1", frame(2 ** 20, false, 3)));
    expect(marks(e.chunks)).toEqual([1, 2, 3]);
    producer?.pathEnded?.("m1", false);
    producer?.consumers.deliver(unit("m2", frame(2 ** 20, false, 5)));
    expect(marks(e.chunks)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a path cut by ace-media's death lets the next one in from its keyframe only", async () => {
    const { media, added } = fakeMedia({ routed: true });
    const { host } = fakeHost("tab", true);
    const e = events();
    const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, e.sink);
    handle.encodes([spec("avc1/640")]);
    const producer = added[0]?.producer;
    await producer?.point(address("m1"));
    producer?.consumers.deliver(unit("m1", frame(2 ** 20, true, 1)));
    // ace-media died: the producer stops, its path ended as cut, then a new ace-media takes it.
    await producer?.point(undefined);
    producer?.pathEnded?.("m1", true);
    await producer?.point(address("m2"));
    producer?.consumers.deliver(unit("m2", frame(2 ** 20, false, 2)));
    producer?.consumers.deliver(unit("m2", frame(2 ** 20, true, 3)));
    producer?.consumers.deliver(unit("m1", frame(2 ** 20, false, 9)));
    expect(marks(e.chunks)).toEqual([1, 3]);
  });

  it("while ace-media can't take a capture, the capture says why, and stops saying it once it streams again", async () => {
    const { media, added } = fakeMedia({ routed: true });
    const { host, captures } = fakeHost("tab", true);
    const stalls: (string | undefined)[] = [];
    await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, {
      ...events().sink,
      stalled: (reason) => void stalls.push(reason),
    });
    const producer = added[0]?.producer;
    await producer?.point(address("m1"));
    await producer?.point(undefined);
    producer?.stopped?.("ace-media stopped and is starting again", "retrying");
    // Nothing is sent anywhere meanwhile: the encoder has no target.
    expect(captures[0]?.targets.at(-1)).toBeUndefined();
    await producer?.point(address("m2"));
    expect(stalls).toEqual([undefined, "ace-media stopped and is starting again", undefined]);
  });

  it("without ace-media a capture doesn't open, and says why; its encoder's capture is closed", async () => {
    const { host, captures } = fakeHost("tab", true);
    await expect(
      mediaVideoHost(host, noMedia, () => ({})).open(page, 640, 400, events().sink),
    ).rejects.toThrow(mediaMissing);
    expect(captures.map((capture) => capture.closed)).toEqual([true]);
    const pictures = fakeHost("user-tab", false);
    await expect(
      mediaVideoHost(pictures.host, noMedia, () => ({})).open(page, 640, 400, events().sink),
    ).rejects.toThrow(mediaMissing);
    expect(pictures.captures).toEqual([]);
  });

  it("a screencast tab routed to ace-media never opens the browser's encoder: pictures and encodes go to ace-media", async () => {
    const { media, added } = fakeMedia({ routed: true });
    const { host, captures } = fakeHost("tab-pictures", false);
    const e = events();
    const routed = mediaVideoHost(host, media, () => ({}));
    expect(await routed.supported(["hvc1.1.6.L153.B0", "avc1.42E033", "vp8"], 640, 400)).toEqual([
      "avc1.42E033",
    ]);
    const handle = await routed.open(page, 640, 400, e.sink);
    expect(captures).toEqual([]);
    handle.encodes([spec("avc1/640")]);
    handle.pictures?.push("aGVsbG8=");
    handle.keyframe("avc1/640");
    expect(added[0]?.encodes).toEqual([
      [{ id: 2 ** 20, codec: "avc1.42E033", width: 640, height: 400, fps: 60, bitrate: 4_000_000 }],
    ]);
    expect(added[0]?.pictures).toEqual(["aGVsbG8="]);
    expect(added[0]?.keys).toEqual([2 ** 20]);
    added[0]?.producer.consumers.deliver(unit("m1", frame(2 ** 20, true, 1)));
    expect(e.chunks.map((c) => c.encode)).toEqual(["avc1/640"]);
  });

  it("codecs ace-media can't encode end the capture, saying so, and no other encoder takes the tab", async () => {
    const { media } = fakeMedia({ routed: true, codecs: ["avc1.640020"] });
    const { host, captures } = fakeHost("user-tab", false);
    const e = events();
    const routed = mediaVideoHost(host, media, () => ({}));
    const handle = await routed.open(page, 640, 400, e.sink);
    handle.encodes([{ ...spec("vp8/640"), codec: "vp8" }]);
    expect(e.failed).toEqual(["vp8/640"]);
    expect(e.ended).toEqual(["ace-media can't encode these codecs here"]);
    await routed.open(page, 640, 400, events().sink);
    expect(captures).toHaveLength(0);
  });

  it("while ace-media starts, a screencast capture waits for it with no encoder of its own, and streams once it is up", async () => {
    const { media, added } = fakeMedia({ routed: false, wanted: true, codecs: [] });
    const { host, captures } = fakeHost("tab-pictures", false);
    const stalls: (string | undefined)[] = [];
    const routed = mediaVideoHost(host, media, () => ({}));
    // Before ace-media has said what it encodes, every codec is offered.
    expect(await routed.supported(["avc1.42E033", "vp8"], 640, 400)).toEqual([
      "avc1.42E033",
      "vp8",
    ]);
    await routed.open(page, 640, 400, { ...events().sink, stalled: (r) => void stalls.push(r) });
    expect(captures).toHaveLength(0);
    expect(added).toHaveLength(1);
    await added[0]?.producer.point(address("m1"));
    expect(added[0]?.closed).toBe(false);
    expect(stalls).toEqual([undefined]);
  });

  it("an encoder that must be made to reach ace-media is told its endpoint before the capture opens", async () => {
    const { media } = fakeMedia({ routed: true });
    const { host, captures } = fakeHost("embedded", true);
    const order: string[] = [];
    const open = host.open;
    host.reach = (url) => {
      order.push(`reach ${url}`);
      return Promise.resolve();
    };
    host.open = (...args) => {
      order.push("open");
      return open(...args);
    };
    await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, events().sink);
    expect(order).toEqual(["reach ws://127.0.0.1:9/ingest", "open"]);
    expect(captures).toHaveLength(1);
  });
});

it("ace-media's plan becomes the capture's, under ace-media's own ids", async () => {
  const { media, added } = fakeMedia({ routed: true });
  const { host, captures } = fakeHost("tab", true);
  const wants: (VideoEncode[] | undefined)[] = [];
  const e = events();
  const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, {
    ...e.sink,
    want: (encodes) => void wants.push(encodes),
  });
  const producer = added[0]?.producer;
  await producer?.point(address("m1"));
  producer?.want?.([
    { id: 1, codec: "avc1.42E033", width: 320, height: 200, fps: 15, bitrate: 150_000 },
  ]);
  const wanted = wants[0]?.[0];
  expect(wanted).toMatchObject({ codec: "avc1.42E033", width: 320, height: 200, fps: 15 });
  if (!wanted) return;
  // When the capture runs it beside the daemon's own, it is stamped with ace-media's id 1.
  handle.encodes([spec("avc1/640"), wanted]);
  const ids = captures[0]?.encodes[0]?.map((s) => s.id);
  expect(ids?.[1]).toBe(1);
  expect(ids?.[0]).not.toBe(1);
});

it("an encode id is never given to another encode while the capture lives", async () => {
  const { media } = fakeMedia({ routed: true });
  const { host, captures } = fakeHost("tab", true);
  const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, events().sink);
  // A capture replanned thousands of times, faster than its queued units can drain.
  for (let n = 0; n < 5_000; n++) handle.encodes([spec(`avc1/${n}`), spec(`vp8/${n}`)]);
  const plans = captures[0]?.encodes ?? [];
  const byId = new Map<number, string>();
  for (const plan of plans)
    for (const encode of plan) {
      const id = encode.id ?? -1;
      // A late unit of an encode can never be taken for a later one's.
      expect(byId.get(id) ?? encode.key).toBe(encode.key);
      byId.set(id, encode.key);
    }
  expect(byId.size).toBe(10_000);
});

it("an id ace-media gives outside its range [1, 2^20) never takes over a daemon encode's", async () => {
  const { media, added } = fakeMedia({ routed: true });
  const { host } = fakeHost("tab", true);
  const wants: (VideoEncode[] | undefined)[] = [];
  const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, {
    ...events().sink,
    want: (encodes) => void wants.push(encodes),
  });
  handle.encodes([spec("avc1/640")]);
  const producer = added[0]?.producer;
  await producer?.point(address("m1"));
  const encode = { codec: "avc1.42E033", width: 320, height: 200, fps: 15, bitrate: 150_000 };
  producer?.want?.([
    { id: 2 ** 20, ...encode },
    { id: 0, ...encode },
    { id: 2 ** 20 - 1, ...encode },
  ]);
  // Only the id in ace-media's range is planned.
  expect(wants[0]?.map((w) => w.key)).toEqual([`media/${2 ** 20 - 1}/avc1.42E033/320x200`]);
});

it("a new path stops ace-media's encodes of the old one before the capture moves to it", async () => {
  const { media, added } = fakeMedia({ routed: true });
  const { host, captures } = fakeHost("tab", true);
  const log: string[] = [];
  const open = host.open;
  host.open = async (...args) => {
    const handle = await open(...args);
    const encodes = handle.encodes;
    const ingest = handle.ingest;
    handle.encodes = (specs) => {
      log.push(`encodes ${specs.map((s) => s.key).join(",")}`);
      encodes(specs);
    };
    if (ingest) handle.ingest = (target) => (log.push("ingest"), ingest(target));
    return handle;
  };
  const wants: (VideoEncode[] | undefined)[] = [];
  const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, {
    ...events().sink,
    want: (encodes) => void wants.push(encodes),
  });
  const producer = added[0]?.producer;
  await producer?.point(address("m1"));
  producer?.want?.([
    { id: 1, codec: "avc1.42E033", width: 320, height: 200, fps: 15, bitrate: 150_000 },
  ]);
  const planned = wants[0]?.[0];
  if (!planned) throw new Error("no plan");
  handle.encodes([spec("avc1/640"), planned]);
  log.length = 0;
  // ace-media reopened the source: its old plan's encode stops, then the capture moves.
  await producer?.point(address("m2"));
  expect(log).toEqual(["encodes avc1/640", "ingest"]);
  // The live video plans its delivered views itself until the new path's plan comes.
  expect(wants.at(-1)).toBeUndefined();
  expect(captures[0]?.targets).toHaveLength(2);
});

it("out of daemon ids, the source reopens, and waiting encodes run once the old path has ended", async () => {
  const { media, added } = fakeMedia({ routed: true });
  const { host, captures } = fakeHost("tab", true);
  const e = events();
  const first = 2 ** 20;
  const handle = await mediaVideoHost(host, media, () => ({}), {
    daemonIds: { first, end: first + 2 },
  }).open(page, 640, 400, e.sink);
  const producer = added[0]?.producer;
  await producer?.point(address("m1"));
  handle.encodes([spec("a"), spec("b")]);
  handle.encodes([spec("a"), spec("c")]);
  // `c` has no id yet: it waits, and the source is opened again.
  expect(captures[0]?.encodes.at(-1)?.map((s) => s.key)).toEqual(["a"]);
  expect(added[0]?.reconnects).toBe(1);
  await producer?.point(address("m2"));
  // The old path's late unit of `b` keeps its label.
  producer?.consumers.deliver(unit("m1", frame(first + 1, true, 1)));
  expect(e.chunks.map((c) => c.encode)).toEqual(["b"]);
  // Its end marker: ids start over past `a`, and `c` runs.
  producer?.pathEnded?.("m1", false);
  expect(captures[0]?.encodes.at(-1)).toEqual([
    expect.objectContaining({ key: "a", id: first }),
    expect.objectContaining({ key: "c", id: first + 1 }),
  ]);
});
