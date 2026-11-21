import { describe, expect, it } from "vitest";
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
import { mediaVideoHost, type BrowserMedia } from "./media-video.ts";
import type { VideoEncode } from "./backend.ts";

const page = {} as BrowserCdp;

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

  it("a tab's own encoder is pointed at the ingest with its token, under the daemon's own encode ids", async () => {
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
    handle.close();
    expect(added[0]?.closed).toBe(true);
    expect(captures[0]?.closed).toBe(true);
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
  });

  it("codecs ace-media can't encode end the capture, and the tab's next captures stay with the browser's encoder", async () => {
    const { media } = fakeMedia({ routed: true, codecs: ["avc1.640020"] });
    const { host, captures } = fakeHost("user-tab", false);
    const e = events();
    const routed = mediaVideoHost(host, media, () => ({}));
    const handle = await routed.open(page, 640, 400, e.sink);
    handle.encodes([{ ...spec("vp8/640"), codec: "vp8" }]);
    expect(e.failed).toEqual(["vp8/640"]);
    expect(e.ended).toHaveLength(1);
    await routed.open(page, 640, 400, events().sink);
    expect(captures).toHaveLength(1);
  });

  it("while ace-media starts, the browser's encoder serves the screencast, and the capture hands over once it is up", async () => {
    const { media, added } = fakeMedia({ routed: false, wanted: true });
    const { host, captures } = fakeHost("tab-pictures", false);
    const e = events();
    await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, e.sink);
    expect(captures).toHaveLength(1);
    expect(added).toHaveLength(1);
    await added[0]?.producer.point(address("m1"));
    expect(captures[0]?.closed).toBe(true);
    expect(added[0]?.closed).toBe(true);
    expect(e.ended).toEqual(["ace-media takes over encoding this tab"]);
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

  it("a host with no ace-media kind is left alone", () => {
    const { media } = fakeMedia({ routed: true });
    const plain: VideoHost = {
      supported: () => Promise.resolve([]),
      open: () => Promise.reject(new Error("no")),
    };
    expect(mediaVideoHost(plain, media, () => ({}))).toBe(plain);
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
  // Its end marker: ids start over past `a`, and `c` runs.
  producer?.pathEnded?.("m1", false);
  expect(captures[0]?.encodes.at(-1)).toEqual([
    expect.objectContaining({ key: "a", id: first }),
    expect.objectContaining({ key: "c", id: first + 1 }),
  ]);
});
