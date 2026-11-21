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
import { EncodeIds, mediaKey, type IdRange } from "./encode-ids.ts";
import type { VideoEncode } from "./video-policy.ts";

/*
 * A browser's video, encoded only through ace-media (E4, X2, docs/media/plan.md "Routes"). Tabs
 * of ace's Chrome and the desktop's views keep their own WebCodecs encoder, which streams its
 * chunks straight into ace-media's ingest (binary); tabs only seen as JPEG screencasts (a
 * private context, "Use my Chrome") have ace-media encode their pictures on this computer's
 * hardware encoder. Either way the units come back on egress to the same `CaptureEvents`, so
 * the live video, its viewers and recordings are unchanged while delivery is legacy. A capture
 * that moves between ace-media paths (a reconnect, a restart) goes through one `PathMerge`, so
 * its units stay in order. While ace-media can't take a capture, nothing streams and the
 * capture says why (`CaptureEvents.stalled`); without ace-media at all a capture can't open.
 */

/** Why a capture can't open on a machine without ace-media. */
export const mediaMissing = "ace-media isn't available on this computer";

/** One source in ace-media, as a capture uses it (`@ace/media`'s `IngestSource`). */
export type BrowserMediaSource = Pick<
  IngestSource,
  "streaming" | "codecs" | "encodes" | "key" | "picture" | "reconnect" | "close"
>;

/** What the browser needs of the daemon's ace-media. */
export interface BrowserMedia {
  /** Undefined while this daemon has no ace-media (not installed, or not started yet). */
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

/** A daemon without ace-media: every capture fails to open, saying why. */
export const noMedia: BrowserMedia = {
  add: () => undefined,
  routed: () => false,
  wanted: () => false,
  pictureCodecs: () => [],
  endpoint: () => undefined,
};

/**
 * The video host of tabs seen only as JPEG screencasts (a private context, "Use my Chrome"):
 * no encoder of its own, since ace-media encodes their pictures (`mediaVideoHost`).
 */
export function pictureSource(kind: "tab-pictures" | "user-tab"): VideoHost {
  return {
    mediaKind: kind,
    supported: () => Promise.resolve([]),
    open: () => Promise.reject(new Error(mediaMissing)),
  };
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

/** A unit off egress as the chunk a capture's listener takes; undefined for other kinds. */
function chunkOf(unit: EgressUnit, ids: EncodeIds): EncodedChunk | undefined {
  const { frame } = unit;
  if (frame.kind !== 1) return undefined;
  const encode = ids.key(frame.encode, unit.source);
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

/** The routed host for each backend host, one per inner host. */
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

/** Limits a test can shrink: the daemon's encode id range, to run it out. */
export type MediaVideoLimits = { daemonIds?: IdRange };

export function mediaVideoHost(
  inner: VideoHost,
  media: BrowserMedia,
  ids: () => Ids,
  limits: MediaVideoLimits = {},
): VideoHost {
  const kind = inner.mediaKind;
  if (kind === "tab-pictures" || kind === "user-tab")
    return pictureHost(inner, kind, media, ids, limits);
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
        limits,
      );
    },
  };
}

type Unit = { chunk: EncodedChunk } | { audio: EncodedAudio };

/** The merge's name for "not streaming anywhere": nothing is ever delivered on it. */
const offPath = "off";

/**
 * A capture whose own encoder streams into ace-media. Each ace-media path's units come back on
 * egress through one merge, so a path's units are handed on only after the previous path's last
 * ones. A capture that can't stream into ace-media doesn't open.
 */
async function streamed(
  open: (events: CaptureEvents) => Promise<VideoCaptureHandle>,
  kind: VideoMediaKind,
  media: BrowserMedia,
  events: CaptureEvents,
  ids: Ids,
  limits: MediaVideoLimits,
): Promise<VideoCaptureHandle> {
  const merge = new PathMerge<Unit>(offPath, {
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
    // The encoder's chunks go to ace-media's ingest; nothing comes this way.
    chunk: () => {},
    failed: (encode) => events.failed(encode),
    ended: (reason) => {
      merge.dispose();
      events.ended(reason);
    },
  });
  const ingest = handle.ingest?.bind(handle);
  if (!ingest) {
    handle.close();
    throw new Error("This browser's encoder can't stream into ace-media");
  }
  let renew: (() => void) | undefined;
  const encodeIds = new EncodeIds({ ...limits, renew: () => renew?.() });
  // The live video's last plan, stamped again when what may run changes.
  let last: readonly VideoEncode[] = [];
  const run = () => handle.encodes(encodeIds.stamp(last));
  /** The ace-media path the capture streams to; undefined while it streams nowhere. */
  let current: string | undefined;
  /** The last path the merge was moved to, and the paths whose end has come (interrupted?). */
  let path = offPath;
  const ended = new Map<string, boolean>([[offPath, false]]);
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
      current = address?.path;
      if (address) {
        const from = path;
        path = address.path;
        merge.switching(path);
        // Nothing more comes on a path already ended (or on none): the new one goes on at once.
        const end = ended.get(from);
        if (end !== undefined) merge.ended(from, end);
        events.stalled?.(undefined);
      }
      if (encodeIds.pointed(current) && last.some((spec) => spec.key.startsWith(mediaKey))) {
        // ace-media's plan was the old path's: its encodes stop before the capture moves (the
        // encoder drops a stopped encode's output at once), so none of their units reach the
        // new path, whose plan starts its ids over. Until that plan comes, the live video
        // plans its delivered views itself.
        run();
        events.want?.(undefined);
      }
      ingest(address ? wire(address) : undefined);
      return Promise.resolve();
    },
    keyframe: (encode) => {
      const key = encodeIds.key(encode, current);
      if (key !== undefined) handle.keyframe(key);
    },
    pathEnded: (gone, interrupted) => {
      ended.set(gone, interrupted);
      merge.ended(gone, interrupted);
      // Every path open when the daemon's ids ran out has ended: encodes waiting for one run.
      if (encodeIds.ended(gone)) run();
    },
    stopped: (reason) => events.stalled?.(reason),
    // ace-media's plan for the views it delivers: the capture runs it, under ace-media's ids.
    want: (encodes) => {
      // An id outside ace-media's range is never pinned: it could be a daemon encode's.
      const planned: VideoEncode[] = encodes.flatMap((encode) => {
        const key = `${mediaKey}${encode.id}/${encode.codec}/${encode.width}x${encode.height}`;
        if (!encodeIds.pin(key, encode.id)) return [];
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
  if (!source) {
    merge.dispose();
    handle.close();
    throw new Error(mediaMissing);
  }
  renew = () => source.reconnect();
  const routed: VideoCaptureHandle = {
    encodes: (specs) => {
      last = specs;
      run();
    },
    keyframe: (key) => handle.keyframe(key),
    codecs: (codecs) => source.codecs([...codecs]),
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
 * A host whose tabs are JPEG screencasts: ace-media encodes their pictures, and nothing else
 * does. Until ace-media has said what it encodes here, every codec asked for is offered; a
 * capture whose codecs it can't encode ends, saying so, and the next one asks again.
 */
function pictureHost(
  inner: VideoHost,
  kind: "tab-pictures" | "user-tab",
  media: BrowserMedia,
  ids: () => Ids,
  limits: MediaVideoLimits,
): VideoHost {
  const offered = (codec: string) => media.pictureCodecs().some((o) => same(o, codec));
  const canEncode = (codecs: readonly string[]) =>
    codecs.length > 0 && (media.pictureCodecs().length === 0 || codecs.every(offered));
  return {
    ...inner,
    mediaKind: kind,
    supported: (codecs) =>
      Promise.resolve(media.pictureCodecs().length === 0 ? [...codecs] : codecs.filter(offered)),
    open: async (_page, width, height, events) => {
      const capture = pictureCapture({
        kind,
        media,
        width,
        height,
        events,
        ids: ids(),
        limits,
        canEncode,
      });
      if (!capture) throw new Error(mediaMissing);
      return capture;
    },
  };
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
  ids: Ids;
  limits: MediaVideoLimits;
  canEncode: (codecs: readonly string[]) => boolean;
}): VideoCaptureHandle | undefined {
  const { events } = options;
  let renew: (() => void) | undefined;
  const encodeIds = new EncodeIds({ ...options.limits, renew: () => renew?.() });
  /** The live video's last plan, sent again once encodes waiting for an id can have one. */
  let last: readonly VideoEncode[] = [];
  const run = () =>
    source?.encodes(
      encodeIds.stamp(last).map((spec) => ({
        id: spec.id,
        codec: spec.codec,
        width: spec.width,
        height: spec.height,
        fps: Math.max(1, Math.round(spec.fps)),
        bitrate: Math.max(1, Math.round(spec.bitrate)),
      })),
    );
  let open = true;
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
      encodeIds.pointed(address?.path);
      // ace-media reads the pictures itself: once it has the source again, they flow again.
      if (address) events.stalled?.(undefined);
      return Promise.resolve();
    },
    stopped: (reason) => events.stalled?.(reason),
    keyframe: () => {},
    pathEnded: (path) => {
      if (encodeIds.ended(path) && open) run();
    },
    refused: (reason) => end(reason ?? "ace-media could not encode this tab"),
  });
  const opened = source;
  if (!opened) return undefined;
  renew = () => opened.reconnect();
  const handle: VideoCaptureHandle = {
    encodes: (specs) => {
      if (!open) return;
      if (!options.canEncode(specs.map((spec) => spec.codec))) {
        for (const spec of specs) events.failed(spec.key);
        return end("ace-media can't encode these codecs here");
      }
      last = specs;
      run();
    },
    keyframe: (key) => {
      const id = encodeIds.id(key);
      if (id !== undefined) opened.key(id);
    },
    codecs: (codecs) => opened.codecs([...codecs]),
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
