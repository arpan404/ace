import { describe, expect, it } from "vitest";
import type { EgressUnit } from "@ace/media/egress";
import type { MediaFrame } from "@ace/media/frame";
import type { MediaSourceListener } from "@ace/media/sources";
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

const unit = (f: MediaFrame): EgressUnit => ({ source: "s", frame: f, sequence: 0, gap: false });

/** ace-media at the browser's edge: each `open` records its listener and what it was told. */
function fakeMedia(state: { routed: boolean; wanted?: boolean; codecs?: string[] }) {
  const opened: {
    kind: VideoMediaKind;
    listener: MediaSourceListener;
    encodes: unknown[];
    pictures: string[];
    keys: number[];
    closed: boolean;
  }[] = [];
  const media: BrowserMedia = {
    open: (kind, listener) => {
      const record = {
        kind,
        listener,
        encodes: [],
        pictures: [],
        keys: [],
        closed: false,
      } as (typeof opened)[number];
      opened.push(record);
      if (state.routed)
        listener.target({
          url: "ws://127.0.0.1:9/ingest",
          socket: "",
          token: new Uint8Array(32).fill(7),
          epoch: 3,
        });
      return {
        encodes: (encodes) => void record.encodes.push(encodes),
        key: (encode) => void record.keys.push(encode),
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
  };
  return { media, opened };
}

/** A backend's host whose captures record what they were told. */
function fakeHost(kind: VideoMediaKind, ingest: boolean) {
  const captures: {
    encodes: VideoEncode[][];
    targets: (VideoIngestTarget | undefined)[];
    pictures: string[];
    closed: boolean;
  }[] = [];
  const host: VideoHost = {
    mediaKind: kind,
    supported: (codecs) => Promise.resolve([...codecs]),
    open: (_page, width, height) => {
      const capture = {
        encodes: [],
        targets: [],
        pictures: [],
        closed: false,
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
  it("a tab's own encoder is pointed at the ingest with its token, and egress units reach the capture as its chunks", async () => {
    const { media, opened } = fakeMedia({ routed: true });
    const { host, captures } = fakeHost("tab", true);
    const e = events();
    const handle = await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, e.sink);
    expect(captures[0]?.targets).toEqual([
      { url: "ws://127.0.0.1:9/ingest", token: Buffer.alloc(32, 7).toString("base64"), epoch: 3 },
    ]);
    handle.encodes([spec("avc1/640"), spec("avc1/320")]);
    expect(captures[0]?.encodes[0]?.map((s) => s.id)).toEqual([1, 2]);
    const listener = opened[0]?.listener;
    listener?.unit(unit(frame(2, true, 9)));
    listener?.unit(unit(frame(2, false, 10)));
    listener?.unit(unit(frame(77, false, 11)));
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
    listener?.target(undefined);
    expect(captures[0]?.targets.at(-1)).toBeUndefined();
    handle.close();
    expect(opened[0]?.closed).toBe(true);
    expect(captures[0]?.closed).toBe(true);
  });

  it("a screencast tab routed to ace-media never opens the browser's encoder: pictures and encodes go to ace-media", async () => {
    const { media, opened } = fakeMedia({ routed: true });
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
    expect(opened[0]?.encodes).toEqual([
      [{ id: 1, codec: "avc1.42E033", width: 640, height: 400, fps: 60, bitrate: 4_000_000 }],
    ]);
    expect(opened[0]?.pictures).toEqual(["aGVsbG8="]);
    expect(opened[0]?.keys).toEqual([1]);
    opened[0]?.listener.unit(unit(frame(1, true, 1)));
    expect(e.chunks.map((c) => c.encode)).toEqual(["avc1/640"]);
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
    const state = { routed: false, wanted: true };
    const { media, opened } = fakeMedia(state);
    const { host, captures } = fakeHost("tab-pictures", false);
    const e = events();
    await mediaVideoHost(host, media, () => ({})).open(page, 640, 400, e.sink);
    expect(captures).toHaveLength(1);
    expect(opened).toHaveLength(1);
    opened[0]?.listener.target({
      url: "ws://127.0.0.1:9/ingest",
      socket: "",
      token: new Uint8Array(32),
      epoch: 0,
    });
    expect(captures[0]?.closed).toBe(true);
    expect(opened[0]?.closed).toBe(true);
    expect(e.ended).toEqual(["ace-media takes over encoding this tab"]);
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
