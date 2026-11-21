import type { IngestAddress, IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import type { MediaAccelerationStore } from "@ace/media/acceleration";
import { IngestWriter, maxStillPictureBytes, stillPictureFrame } from "@ace/media/ingest-writer";
import type {
  CapturePrivacy,
  CaptureEvents,
  VideoCaptureHandle,
  VideoHost,
  VideoIngestTarget,
  VideoMediaKind,
} from "./backend.ts";
import { EncodeIds, mediaKey, type IdRange } from "./encode-ids.ts";
import type { VideoEncode } from "./backend.ts";

/*
 * A browser's video, encoded only through ace-media (E4, X2, docs/media/plan.md "Routes"). Tabs
 * of ace's Chrome and the desktop's views keep their own WebCodecs encoder, which streams its
 * chunks straight into ace-media's ingest (binary); tabs only seen as JPEG screencasts (a
 * private context, "Use my Chrome") have ace-media encode their pictures on this computer's
 * hardware encoder, the pictures on the source's own ingest. Either way ace-media delivers every
 * view itself (X3): no unit comes back to the daemon's viewers, and a capture tells the live
 * video only that it plays. While ace-media can't take a capture, nothing streams and the
 * capture says why (`CaptureEvents.stalled`); without ace-media at all a capture can't open.
 */

/** Why a capture can't open on a machine without ace-media. */
export const mediaMissing = "ace-media isn't available on this computer";

/** One source in ace-media, as a capture uses it (`@ace/media`'s `IngestSource`). */
export type BrowserMediaSource = Pick<
  IngestSource,
  "streaming" | "codecs" | "encodes" | "key" | "epoch" | "reconnect" | "close"
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

let captures = 0;

function wire(address: IngestAddress): VideoIngestTarget {
  return {
    url: address.url,
    token: Buffer.from(address.token).toString("base64"),
    epoch: address.epoch,
  };
}

/** A browser source takes nothing back on egress: ace-media delivers its views (X3), and its
 * recordings come from the screencast. */
const consumers = { deliver: () => {} };

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
    open: async (page, width, height, events, privacy) => {
      const endpoint = media.endpoint();
      if (endpoint && media.routed(kind)) await inner.reach?.(endpoint).catch(() => {});
      return streamed(
        (merged) => inner.open(page, width, height, merged, privacy),
        kind,
        media,
        events,
        ids(),
        limits,
      );
    },
  };
}

/**
 * A capture whose own encoder streams into ace-media, which delivers its views. A capture that
 * can't stream into ace-media doesn't open.
 */
async function streamed(
  open: (events: CaptureEvents) => Promise<VideoCaptureHandle>,
  kind: VideoMediaKind,
  media: BrowserMedia,
  events: CaptureEvents,
  ids: Ids,
  limits: MediaVideoLimits,
): Promise<VideoCaptureHandle> {
  const handle = await open({
    // The encoder's chunks go to ace-media's ingest; nothing comes this way.
    chunk: () => {},
    failed: (encode) => events.failed(encode),
    ended: (reason) => events.ended(reason),
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
  const name = `capture-${++captures}`;
  const source = media.add({
    source: name,
    kind,
    origin: { kind },
    ...ids,
    epoch: () => 0,
    consumers,
    point: (address) => {
      current = address?.path;
      if (address) events.stalled?.(undefined);
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
    pathEnded: (gone) => {
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
    open: async (_page, width, height, events, privacy) => {
      const capture = pictureCapture({
        kind,
        media,
        width,
        height,
        events,
        ids: ids(),
        limits,
        canEncode,
        privacy: privacy ?? { epoch: 0, private: false },
      });
      if (!capture) throw new Error(mediaMissing);
      return capture;
    },
  };
}

/** The bytes base64 text decodes to, from its length and padding alone. */
function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
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
  /** The tab's privacy as the capture opens: the producer registers in it. */
  privacy: CapturePrivacy;
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
  /** The ingest connection the pictures go on, while ace-media holds the source. */
  let writer: IngestWriter | undefined;
  /** Pictures too large for ace-media, dropped rather than sent. */
  let dropped = 0;
  /** The tab's privacy now (M8): what the capture opened in, then each change since. */
  let privacy = { ...options.privacy };
  const pointAt = (address: IngestAddress | undefined) => {
    // Every picture the old connection holds goes before its end; a new one starts afresh.
    writer?.finish();
    writer = undefined;
    if (!address || !open) {
      address?.token.fill(0);
      return;
    }
    const made: IngestWriter = new IngestWriter({
      socket: address.socket,
      token: address.token,
      onClosed: () => {
        if (writer !== made) return;
        writer = undefined;
        // ace-media went away or cut the path: the source opens again, on a new ingest.
        if (open) source?.reconnect();
      },
      onKeyframe: () => {},
    });
    writer = made;
  };
  const end = (reason: string) => {
    if (!open) return;
    open = false;
    writer?.close();
    source?.close();
    events.ended(reason);
  };
  const name = `capture-${++captures}`;
  source = options.media.add({
    source: name,
    kind: options.kind,
    origin: { kind: options.kind },
    ...options.ids,
    epoch: () => privacy.epoch,
    private: () => privacy.private,
    consumers,
    point: (address) => {
      encodeIds.pointed(address?.path);
      pointAt(address);
      // ace-media has the source again: the pictures flow on its new ingest.
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
      // Sized from the text before any copy: one too large for ace-media is never decoded.
      push: (base64, epoch) => {
        if (!open || !writer) return;
        if (decodedLength(base64) > maxStillPictureBytes) {
          dropped++;
          return;
        }
        const picture = stillPictureFrame(
          Buffer.from(base64, "base64"),
          { width: options.width, height: options.height },
          epoch,
        );
        if (picture) writer.write(picture);
        else dropped++;
      },
      dropped: () => dropped,
      // The tab's privacy changed: ace-media hears the epoch as a video producer's stamper
      // applies it, and a picture still waiting for room from a private epoch is never sent.
      epoch: (next, followsPrivate) => {
        privacy = { ...next };
        if (followsPrivate) writer?.discardWaiting();
        opened.epoch?.(next.epoch, followsPrivate);
      },
    },
    close: () => {
      if (!open) return;
      open = false;
      // Gracefully: the waiting picture, then the ingest's end, after which ace-media drains
      // its encoder and sends the marker; the source's handle waits for it (or the drain limit).
      writer?.finish();
      writer = undefined;
      opened.close();
    },
  };
  return reported(handle, options.media, name, events);
}
