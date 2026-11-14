import type { EgressUnit } from "@ace/media/egress";
import type { IngestTarget, MediaSource, MediaSourceListener } from "@ace/media/sources";
import type {
  CaptureEvents,
  EncodedChunk,
  VideoCaptureHandle,
  VideoHost,
  VideoMediaKind,
} from "./backend.ts";
import type { VideoEncode } from "./video-policy.ts";

/*
 * A browser's video encoder routed through ace-media (E4, docs/media/plan.md "Routes"). Tabs
 * of ace's Chrome and the desktop's views keep their own WebCodecs encoder, but stream its
 * chunks straight into ace-media's ingest (binary, no base64 over CDP) while their route says
 * so; tabs only seen as JPEG screencasts (a private context, "Use my Chrome") have ace-media
 * encode their pictures on this computer's hardware encoder instead of the daemon's encoder
 * Chrome. Either way the units come back on egress to the same `CaptureEvents`, so the live
 * video, its viewers and recordings are unchanged while delivery is legacy.
 */

/** What the browser needs of the daemon's ace-media. */
export interface BrowserMedia {
  /** Undefined while this daemon has no ace-media (never asked for, or not installed). */
  open(
    kind: VideoMediaKind,
    listener: MediaSourceListener,
    ids?: { threadId?: string; tabId?: string },
  ): MediaSource | undefined;
  /** A kind's producers stream into ace-media now. */
  routed(kind: VideoMediaKind): boolean;
  /** The codecs ace-media encodes pictures in on this computer, best first. */
  pictureCodecs(): readonly string[];
}

/** An encode's id in ace-media's frames, per capture, from 1. */
class EncodeIds {
  readonly #ids = new Map<string, number>();
  readonly #keys = new Map<number, string>();
  #next = 1;
  id(key: string): number {
    let id = this.#ids.get(key);
    if (id === undefined) {
      id = this.#next++;
      this.#ids.set(key, id);
      this.#keys.set(id, key);
    }
    return id;
  }
  key(id: number): string | undefined {
    return this.#keys.get(id);
  }
  /** Specs with their ids, for producers that stamp frames with them. */
  stamp(specs: readonly VideoEncode[]): (VideoEncode & { id: number })[] {
    return specs.map((spec) => ({ ...spec, id: this.id(spec.key) }));
  }
}

/** A unit off egress as the chunk a capture's listener takes; undefined for other kinds. */
function chunkOf(unit: EgressUnit, ids: EncodeIds): EncodedChunk | undefined {
  const { frame } = unit;
  if (frame.kind !== 1) return undefined;
  const encode = ids.key(frame.encode);
  if (encode === undefined) return undefined;
  const key = (frame.flags & 1) !== 0;
  const described = key && (frame.flags & 4) !== 0 && frame.description.length > 0;
  return {
    encode,
    key,
    codec: frame.codecString,
    codedWidth: frame.width,
    codedHeight: frame.height,
    ...(described ? { description: frame.description } : {}),
    age: frame.ageUs / 1000,
    bytes: frame.payload,
  };
}

function audioOf(unit: EgressUnit, events: CaptureEvents): void {
  const { frame } = unit;
  if (frame.kind !== 2 || frame.description.length < 5) return;
  const view = new DataView(
    frame.description.buffer,
    frame.description.byteOffset,
    frame.description.byteLength,
  );
  events.audio?.({
    codec: "opus",
    sampleRate: view.getUint32(0),
    channels: frame.description[4] ?? 1,
    age: frame.ageUs / 1000,
    bytes: frame.payload,
  });
}

function wire(target: IngestTarget): { url: string; token: string; epoch: number } {
  const token = Buffer.from(target.token).toString("base64");
  target.token.fill(0);
  return { url: target.url, token, epoch: target.epoch };
}

/**
 * The routed host for each backend host, kept per inner host so what a host learned (that
 * ace-media refused its pictures) lasts as long as the host does.
 */
export function mediaVideoHosts(
  media: BrowserMedia,
  ids: () => { threadId?: string; tabId?: string },
): (inner: VideoHost) => VideoHost {
  const routed = new WeakMap<VideoHost, VideoHost>();
  return (inner) => {
    let host = routed.get(inner);
    if (!host) {
      host = mediaVideoHost(inner, media, ids);
      routed.set(inner, host);
    }
    return host;
  };
}

export function mediaVideoHost(
  inner: VideoHost,
  media: BrowserMedia,
  ids: () => { threadId?: string; tabId?: string },
): VideoHost {
  const kind = inner.mediaKind;
  if (!kind) return inner;
  if (kind === "tab-pictures" || kind === "user-tab") return pictureHost(inner, kind, media, ids);
  return {
    ...inner,
    mediaKind: kind,
    supported: (codecs, width, height) => inner.supported(codecs, width, height),
    open: async (page, width, height, events) => {
      const handle = await inner.open(page, width, height, events);
      return handle.ingest ? streamed(handle, kind, media, events, ids()) : handle;
    },
  };
}

/**
 * A capture whose own encoder streams into ace-media while its route says so: its chunks go to
 * the daemon or to ace-media, never both, and the ones from ace-media come back on egress.
 */
function streamed(
  handle: VideoCaptureHandle,
  kind: VideoMediaKind,
  media: BrowserMedia,
  events: CaptureEvents,
  ids: { threadId?: string; tabId?: string },
): VideoCaptureHandle {
  const encodeIds = new EncodeIds();
  const ingest = handle.ingest?.bind(handle);
  const source = media.open(
    kind,
    {
      target: (target) => ingest?.(target ? wire(target) : undefined),
      unit: (unit) => {
        const chunk = chunkOf(unit, encodeIds);
        if (chunk) events.chunk(chunk);
        else audioOf(unit, events);
      },
      keyframe: (encode) => {
        const key = encodeIds.key(encode);
        if (key !== undefined) handle.keyframe(key);
      },
    },
    ids,
  );
  if (!source) return handle;
  return {
    encodes: (specs) => handle.encodes(encodeIds.stamp(specs)),
    keyframe: (key) => handle.keyframe(key),
    ...(handle.audio ? { audio: (on: boolean) => handle.audio?.(on) } : {}),
    close: () => {
      source.close();
      handle.close();
    },
  };
}

/**
 * A host whose tabs are JPEG screencasts. While its route says so, ace-media encodes the
 * pictures and no encoder Chrome starts; otherwise, or once ace-media can't encode them, the
 * inner host (the daemon's encoder Chrome) does.
 */
function pictureHost(
  inner: VideoHost,
  kind: "tab-pictures" | "user-tab",
  media: BrowserMedia,
  ids: () => { threadId?: string; tabId?: string },
): VideoHost {
  const canEncode = (codecs: readonly string[]) => {
    const offered = media.pictureCodecs();
    return codecs.length > 0 && codecs.every((codec) => offered.some((o) => same(o, codec)));
  };
  /** After ace-media ended a capture on its own, its next ones stay with the inner host. */
  let refused = false;
  const host: VideoHost = {
    ...inner,
    mediaKind: kind,
    supported: (codecs, width, height) => {
      if (!refused && media.routed(kind)) {
        const offered = media.pictureCodecs();
        return Promise.resolve(codecs.filter((codec) => offered.some((o) => same(o, codec))));
      }
      return inner.supported(codecs, width, height);
    },
    open: (page, width, height, events) => {
      if (refused || !media.routed(kind)) return inner.open(page, width, height, events);
      const capture = pictureCapture({
        kind,
        media,
        width,
        height,
        events,
        ids: ids(),
        canEncode,
        refuse: () => {
          refused = true;
        },
      });
      return capture ? Promise.resolve(capture) : inner.open(page, width, height, events);
    },
  };
  return host;
}

/** Same codec family: ace-media writes the profile and level it chose. */
function same(offered: string, asked: string): boolean {
  return offered.slice(0, 4) === asked.slice(0, 4);
}

function pictureCapture(options: {
  kind: "tab-pictures" | "user-tab";
  media: BrowserMedia;
  width: number;
  height: number;
  events: CaptureEvents;
  ids: { threadId?: string; tabId?: string };
  canEncode: (codecs: readonly string[]) => boolean;
  refuse: () => void;
}): VideoCaptureHandle | undefined {
  const { events } = options;
  const encodeIds = new EncodeIds();
  let open = true;
  let streaming = false;
  const end = (reason: string) => {
    if (!open) return;
    open = false;
    opened?.close();
    events.ended(reason);
  };
  const opened: MediaSource | undefined = options.media.open(
    options.kind,
    {
      target: (target) => {
        if (target) target.token.fill(0);
        const was = streaming;
        streaming = target !== undefined;
        // ace-media went away (or the route left it): the live video opens a new capture,
        // which the inner host serves until ace-media is back.
        if (was && !streaming) end("ace-media stopped encoding this tab");
      },
      unit: (unit) => {
        const chunk = chunkOf(unit, encodeIds);
        if (open && chunk) events.chunk(chunk);
      },
      ended: (reason) => {
        options.refuse();
        end(reason ?? "ace-media could not encode this tab");
      },
    },
    options.ids,
  );
  if (!opened) return undefined;
  const source = opened;
  return {
    encodes: (specs) => {
      if (!open) return;
      if (!options.canEncode(specs.map((spec) => spec.codec))) {
        options.refuse();
        for (const spec of specs) events.failed(spec.key);
        return end("ace-media can't encode these codecs here");
      }
      source.encodes(
        encodeIds.stamp(specs).map((spec) => ({
          id: spec.id,
          codec: spec.codec,
          width: spec.width,
          height: spec.height,
          fps: Math.max(1, Math.round(spec.fps)),
          bitrate: Math.max(1, Math.round(spec.bitrate)),
        })),
      );
    },
    keyframe: (key) => source.key(encodeIds.id(key)),
    pictures: {
      width: options.width,
      height: options.height,
      push: (base64) => {
        if (open) source.picture(base64);
      },
    },
    close: () => {
      if (!open) return;
      open = false;
      source.close();
    },
  };
}
