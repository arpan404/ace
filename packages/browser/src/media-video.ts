import type { EgressUnit } from "@ace/media/egress";
import type { IngestAddress, IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import type { MediaAccelerationStore } from "@ace/media/acceleration";
import { PathMerge } from "@ace/media/path-merge";
import type {
  CaptureEvents,
  EncodedAudio,
  EncodedChunk,
  VideoCaptureHandle,
  VideoHost,
  VideoIngestTarget,
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
 * video, its viewers and recordings are unchanged while delivery is legacy. A capture that
 * moves between the two paths goes through one `PathMerge`, so its units stay in order.
 */

/** One source in ace-media, as a capture uses it (`@ace/media`'s `IngestSource`). */
export type BrowserMediaSource = Pick<
  IngestSource,
  "streaming" | "encodes" | "key" | "picture" | "close"
>;

/** What the browser needs of the daemon's ace-media. */
export interface BrowserMedia {
  /** Undefined while this daemon has no ace-media (never asked for, or not installed). */
  add(producer: IngestProducer): BrowserMediaSource | undefined;
  /** A kind's producers stream into ace-media now. */
  routed(kind: VideoMediaKind): boolean;
  /** The settings route a kind through ace-media once it is up. */
  wanted(kind: VideoMediaKind): boolean;
  /** The codecs ace-media encodes pictures in on this computer, best first. */
  pictureCodecs(): readonly string[];
  /** ace-media's ingest WebSocket now, while it runs. */
  endpoint(): string | undefined;
  /** ace-media's reports of what each source runs on (ADR 0148). */
  acceleration?: Pick<MediaAccelerationStore, "of" | "watch"> | undefined;
}

/**
 * The capture's ace-media report: `acceleration()` reads it, and `events.accelerated` hears each
 * change, until the capture closes.
 */
function reported(
  handle: VideoCaptureHandle,
  media: BrowserMedia,
  source: string,
  events: CaptureEvents,
): VideoCaptureHandle {
  const store = media.acceleration;
  if (!store) return handle;
  const unwatch = store.watch((change) => {
    if (change.kind === "source" && change.source === source) events.accelerated?.();
  });
  return {
    ...handle,
    acceleration: () => store.of(source),
    close: () => {
      unwatch();
      handle.close();
    },
  };
}

type Ids = { threadId?: string; tabId?: string };

/** How long a capture's new path waits for its old path's end before starting at a keyframe. */
const holdMs = 1_000;
let captures = 0;

/**
 * The daemon's own encodes' ids start here, above ace-media's (from 0, D1), so the two plans can
 * run side by side in one capture.
 */
const daemonIds = 2 ** 20;
/** The key prefix of an encode ace-media planned, which keeps ace-media's own id. */
const mediaKey = "media/";

/** An encode's id in ace-media's frames, per capture: the daemon's from `daemonIds`. */
class EncodeIds {
  readonly #ids = new Map<string, number>();
  readonly #keys = new Map<number, string>();
  #next = daemonIds;
  /** An encode ace-media planned: its key keeps ace-media's id. */
  pin(key: string, id: number): void {
    this.#ids.set(key, id);
    this.#keys.set(id, key);
  }
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

function audioOf(unit: EgressUnit): EncodedAudio | undefined {
  const { frame } = unit;
  if (frame.kind !== 2 || frame.description.length < 5) return undefined;
  const view = new DataView(
    frame.description.buffer,
    frame.description.byteOffset,
    frame.description.byteLength,
  );
  return {
    codec: "opus",
    sampleRate: view.getUint32(0),
    channels: frame.description[4] ?? 1,
    age: frame.ageUs / 1000,
    bytes: frame.payload,
  };
}

function wire(address: IngestAddress): VideoIngestTarget {
  return {
    url: address.url,
    token: Buffer.from(address.token).toString("base64"),
    epoch: address.epoch,
  };
}

const consumers = (deliver: (unit: EgressUnit) => void) => ({
  deliver,
  record: () => {},
  still: () => {},
});

/**
 * The routed host for each backend host, kept per inner host so what a host learned (that
 * ace-media refused its pictures) lasts as long as the host does.
 */
export function mediaVideoHosts(
  media: BrowserMedia,
  ids: () => Ids,
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

export function mediaVideoHost(inner: VideoHost, media: BrowserMedia, ids: () => Ids): VideoHost {
  const kind = inner.mediaKind;
  if (!kind) return inner;
  if (kind === "tab-pictures" || kind === "user-tab") return pictureHost(inner, kind, media, ids);
  return {
    ...inner,
    mediaKind: kind,
    supported: (codecs, width, height) => inner.supported(codecs, width, height),
    open: async (page, width, height, events) => {
      const endpoint = media.endpoint();
      if (endpoint && media.routed(kind)) await inner.reach?.(endpoint).catch(() => {});
      return streamed(
        (merged) => inner.open(page, width, height, merged),
        kind,
        media,
        events,
        ids(),
      );
    },
  };
}

type Unit = { chunk: EncodedChunk } | { audio: EncodedAudio };

/**
 * A capture whose own encoder streams into ace-media while its route says so. Its chunks go to
 * the daemon or to ace-media, never both; both paths feed one merge, so a path's units are
 * handed on only after the previous path's last ones.
 */
async function streamed(
  open: (events: CaptureEvents) => Promise<VideoCaptureHandle>,
  kind: VideoMediaKind,
  media: BrowserMedia,
  events: CaptureEvents,
  ids: Ids,
): Promise<VideoCaptureHandle> {
  const merge = new PathMerge<Unit>("daemon", {
    emit: (unit) => {
      if ("chunk" in unit) events.chunk(unit.chunk);
      else events.audio?.(unit.audio);
    },
    stream: (unit) => ("chunk" in unit ? unit.chunk.encode : "audio"),
    key: (unit) => !("chunk" in unit) || unit.chunk.key,
    bytes: (unit) => ("chunk" in unit ? unit.chunk.bytes.length : unit.audio.bytes.length),
    schedule: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    holdMs,
  });
  const handle = await open({
    chunk: (chunk) => merge.deliver("daemon", { chunk }),
    audio: (audio) => merge.deliver("daemon", { audio }),
    failed: (encode) => events.failed(encode),
    ended: (reason) => {
      merge.dispose();
      events.ended(reason);
    },
    // The encoder's own word on the daemon's path, ordered with its chunks there.
    moved: (to) => {
      if (to === "ingest") merge.ended("daemon", false);
      else merge.switching("daemon");
    },
  });
  const ingest = handle.ingest?.bind(handle);
  if (!ingest) return handle;
  const encodeIds = new EncodeIds();
  const name = `capture-${++captures}`;
  const source = media.add({
    source: name,
    kind,
    origin: { kind },
    ...ids,
    epoch: () => 0,
    consumers: consumers((unit) => {
      const chunk = chunkOf(unit, encodeIds);
      if (chunk) return merge.deliver(unit.source, { chunk });
      const audio = audioOf(unit);
      if (audio) merge.deliver(unit.source, { audio });
    }),
    point: (address) => {
      merge.switching(address ? address.path : "daemon");
      ingest(address ? wire(address) : undefined);
      return Promise.resolve();
    },
    keyframe: (encode) => {
      const key = encodeIds.key(encode);
      if (key !== undefined) handle.keyframe(key);
    },
    pathEnded: (path, interrupted) => merge.ended(path, interrupted),
    // ace-media's plan for the views it delivers: the capture runs it, under ace-media's ids.
    want: (encodes) => {
      const planned: VideoEncode[] = encodes.map((encode) => {
        const key = `${mediaKey}${encode.id}/${encode.codec}/${encode.width}x${encode.height}`;
        encodeIds.pin(key, encode.id);
        return {
          key,
          codec: encode.codec,
          width: encode.width,
          height: encode.height,
          fps: encode.fps,
          bitrate: encode.bitrate,
        };
      });
      events.want?.(planned);
    },
  });
  if (!source) return handle;
  const routed: VideoCaptureHandle = {
    encodes: (specs) => handle.encodes(encodeIds.stamp(specs)),
    keyframe: (key) => handle.keyframe(key),
    ...(handle.audio ? { audio: (on: boolean) => handle.audio?.(on) } : {}),
    close: () => {
      merge.dispose();
      source.close();
      handle.close();
    },
  };
  return reported(routed, media, name, events);
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
  ids: () => Ids,
): VideoHost {
  const offered = (codec: string) => media.pictureCodecs().some((o) => same(o, codec));
  const canEncode = (codecs: readonly string[]) => codecs.length > 0 && codecs.every(offered);
  /** After ace-media ended a capture on its own, its next ones stay with the inner host. */
  let refused = false;
  return {
    ...inner,
    mediaKind: kind,
    supported: (codecs, width, height) => {
      if (!refused && media.routed(kind)) return Promise.resolve(codecs.filter(offered));
      return inner.supported(codecs, width, height);
    },
    open: async (page, width, height, events) => {
      if (refused || !media.routed(kind)) {
        const handle = await inner.open(page, width, height, events);
        return !refused && media.wanted(kind)
          ? untilMedia(handle, kind, media, events, ids())
          : handle;
      }
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
      return capture ?? inner.open(page, width, height, events);
    },
  };
}

/** Same codec family: ace-media writes the profile and level it chose. */
function same(offered: string, asked: string): boolean {
  return offered.slice(0, 4) === asked.slice(0, 4);
}

/**
 * A picture capture on the inner host while ace-media, which the settings want, isn't up yet
 * (it starts on its first need). A source held open in ace-media brings it up; once it is, the
 * capture ends so the live video opens the next one there.
 */
function untilMedia(
  handle: VideoCaptureHandle,
  kind: VideoMediaKind,
  media: BrowserMedia,
  events: CaptureEvents,
  ids: Ids,
): VideoCaptureHandle {
  let open = true;
  let watch: BrowserMediaSource | undefined;
  watch = media.add({
    source: `capture-${++captures}`,
    kind,
    origin: { kind },
    ...ids,
    epoch: () => 0,
    consumers: consumers(() => {}),
    point: (address) => {
      if (!address || !open) return Promise.resolve();
      address.token.fill(0);
      open = false;
      watch?.close();
      handle.close();
      events.ended("ace-media takes over encoding this tab");
      return Promise.resolve();
    },
    keyframe: () => {},
  });
  const held = watch;
  if (!held) return handle;
  return {
    ...handle,
    close: () => {
      if (!open) return;
      open = false;
      held.close();
      handle.close();
    },
  };
}

function pictureCapture(options: {
  kind: "tab-pictures" | "user-tab";
  media: BrowserMedia;
  width: number;
  height: number;
  events: CaptureEvents;
  ids: Ids;
  canEncode: (codecs: readonly string[]) => boolean;
  refuse: () => void;
}): VideoCaptureHandle | undefined {
  const { events } = options;
  const encodeIds = new EncodeIds();
  let open = true;
  let streaming = false;
  let source: BrowserMediaSource | undefined;
  const end = (reason: string) => {
    if (!open) return;
    open = false;
    source?.close();
    events.ended(reason);
  };
  const name = `capture-${++captures}`;
  source = options.media.add({
    source: name,
    kind: options.kind,
    origin: { kind: options.kind },
    ...options.ids,
    epoch: () => 0,
    consumers: consumers((unit) => {
      const chunk = chunkOf(unit, encodeIds);
      if (open && chunk) events.chunk(chunk);
    }),
    point: (address) => {
      address?.token.fill(0);
      const was = streaming;
      streaming = address !== undefined;
      // ace-media went away (or the route left it): the live video opens a new capture, which
      // the inner host serves until ace-media is back.
      if (was && !streaming) end("ace-media stopped encoding this tab");
      return Promise.resolve();
    },
    keyframe: () => {},
    refused: (reason) => {
      options.refuse();
      end(reason ?? "ace-media could not encode this tab");
    },
  });
  const opened = source;
  if (!opened) return undefined;
  const handle: VideoCaptureHandle = {
    encodes: (specs) => {
      if (!open) return;
      if (!options.canEncode(specs.map((spec) => spec.codec))) {
        options.refuse();
        for (const spec of specs) events.failed(spec.key);
        return end("ace-media can't encode these codecs here");
      }
      opened.encodes(
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
    keyframe: (key) => opened.key(encodeIds.id(key)),
    pictures: {
      width: options.width,
      height: options.height,
      push: (base64) => {
        if (open) opened.picture(base64);
      },
    },
    close: () => {
      if (!open) return;
      open = false;
      opened.close();
    },
  };
  return reported(handle, options.media, name, events);
}
