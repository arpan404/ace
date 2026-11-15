import type { EgressUnit } from "@ace/media/egress";
import type { MediaFrame } from "@ace/media/frame";
import {
  h264Only,
  type IngestAddress,
  type IngestProducer,
  type IngestSource,
} from "@ace/media/ingest-sources";
import { readProducerStamp } from "@ace/media/producer-stamp";
import {
  ScreenStreamConfigured,
  type ScreenStreamIngest,
  type ScreenStreamSettings,
} from "@ace/protocol";
import { wireFrame, type Frame } from "./frames.ts";
import type { HelperPort } from "./helper-session.ts";
import { StreamOwners } from "./stream-owners.ts";
import { PathMerge } from "@ace/media/path-merge";

/**
 * A Mac, Windows or Linux screen session as an ace-media producer (docs/media/plan.md, E3, E1,
 * E2). When the route sends screens to ace-media, the helper is given the ingest socket with
 * each `stream.configure` and writes its H.264 there. On Linux the daemon's path keeps today's
 * JPEG pictures, which the daemon encodes for viewers as before, so only the ace-media route
 * runs the helper's encoder; ace-media's egress brings the units back as the frames the helper's
 * socket would have carried, header for header, for the daemon's legacy viewer, recorder and
 * stills. Both paths go through one ordered merge, so a route change loses or repeats nothing.
 */

/**
 * Whether a screen helper makes its own video: the Mac's (VideoToolbox), Windows' where its
 * start-up trial found a Media Foundation H.264 encoder, and Linux's where one of its encoders
 * (VA-API, NVENC or the last resort) worked. A helper offering only JPEG gets its video from the
 * daemon's last-resort encoder instead.
 */
export function helperEncodesVideo(
  capabilities: { platform: string; codecs: readonly string[] } | undefined,
): boolean {
  return (
    (capabilities?.platform === "macos" ||
      capabilities?.platform === "windows" ||
      capabilities?.platform.startsWith("linux") === true) &&
    capabilities.codecs.includes("h264")
  );
}

/**
 * Whether a helper's video goes to ace-media only (Linux, E2): on the daemon's path it sends the
 * JPEG pictures the daemon has always encoded itself, so `media.encode: legacy` keeps today's path.
 */
export function videoOnlyToMedia(capabilities: { platform: string } | undefined): boolean {
  return capabilities?.platform.startsWith("linux") === true;
}

/** Where screen sources are opened in ace-media: the daemon's `IngestSources`. */
export type ScreenMedia = { add(producer: IngestProducer): IngestSource };

/** Until recordings issue epochs for screens (F1), a screen's frames carry its opening one. */
export const screenOpeningEpoch = 1;

const MediaVideo = 1;
const H264AnnexB = 1;
const Keyframe = 1;

/** One egress unit as the frame the helper's own socket carries; undefined when it isn't one. */
export function egressScreenFrame(sessionId: string, frame: MediaFrame): Frame | undefined {
  if (frame.kind !== MediaVideo || frame.codec !== H264AnnexB || frame.payload.length === 0)
    return undefined;
  const stamp = readProducerStamp(frame.extension);
  if (!stamp || frame.width === 0 || frame.height === 0) return undefined;
  const keyframe = (frame.flags & Keyframe) !== 0;
  try {
    return wireFrame(
      {
        version: 2,
        sessionId,
        seq: stamp.sequence,
        ts: stamp.timestamp,
        width: frame.width,
        height: frame.height,
        scale: stamp.scale,
        codec: "h264",
        keyframe,
        ...(keyframe && frame.codecString ? { videoCodec: frame.codecString } : {}),
        bytes: frame.payload.length,
      },
      frame.payload,
    );
  } catch {
    return undefined;
  }
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Math.round(value)));

/**
 * ace-media's plan for a stream's views (`source.want`) as one stream request, for a producer
 * that runs one stream (the screen helper, a device): the largest wanted encode, held to what
 * `stream.configure` takes. Undefined for an empty plan.
 */
export function wantedStreamSettings(
  encodes: readonly { width: number; height: number; fps: number; bitrate: number }[],
): ScreenStreamSettings | undefined {
  const encode = encodes.toSorted((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!encode) return undefined;
  return {
    codec: "h264",
    maxWidth: clamp(encode.width, 64, 3840),
    maxHeight: clamp(encode.height, 64, 3840),
    fps: clamp(encode.fps, 1, 60),
    bitrate: clamp(encode.bitrate, 128_000, 20_000_000),
  };
}

export type ScreenMediaSourceOptions = {
  sessionId: string;
  /** The helper's platform, as its hello names it (`macos`, `windows`, `linux-wayland`): ace-media's
   * origin, and whether the daemon's path carries video (`videoOnlyToMedia`). */
  platform: string;
  helper: HelperPort;
  media: ScreenMedia;
  /** A frame from either path, video in sequence order and stills in theirs. */
  accept: (frame: Frame) => void;
  schedule: (callback: () => void, milliseconds: number) => () => void;
};

const daemonPath = "daemon";
/** The two demands on the helper's stream. */
const legacyOwner = "legacy";
const mediaOwner = "ace-media";

export class ScreenMediaSource {
  readonly #options: ScreenMediaSourceOptions;
  /** Video only: it is what moves between the helper socket and ace-media. */
  readonly #merge: PathMerge<Frame>;
  readonly #source: IngestSource;
  #settings: ScreenStreamSettings | undefined;
  /** What the helper runs while nobody asks for video: the legacy viewers' JPEG request. */
  #idle: ScreenStreamSettings | undefined;
  /** The helper's one stream, shared by the legacy viewers and ace-media's views. */
  readonly #owners = new StreamOwners({
    apply: (settings) => this.#apply(settings),
    idle: () => this.#idle,
  });
  /** The current ace-media address, as the helper takes it, and its path's name. */
  #address: { ingest: ScreenStreamIngest; path: string } | undefined;
  /** Where the helper sends video now: the daemon's path or an ace-media path. */
  #onPath = daemonPath;
  /** Switching off the helper socket: its last video sequence there, not yet delivered. */
  #daemonBoundary: number | undefined;
  #lastDaemonVideo = -1;
  /** The last video and still handed on: each keeps its own order. */
  #lastVideo = -1;
  #lastStill = -1;
  #stale = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #lastUnit: EgressUnit | undefined;
  #closed = false;

  constructor(options: ScreenMediaSourceOptions) {
    this.#options = options;
    this.#merge = new PathMerge<Frame>(daemonPath, {
      emit: (frame) => this.#hand(frame),
      // One encode per session: the helper restarts it at a keyframe.
      stream: () => "video",
      key: (frame) => frame.header.keyframe === true,
      bytes: (frame) => frame.payload.length,
      schedule: options.schedule,
    });
    const unit = (egress: EgressUnit) => this.#egress(egress);
    this.#source = options.media.add({
      source: `screen:${options.sessionId}`,
      kind: "screen",
      origin: { kind: "screen", platform: options.platform },
      sessionId: options.sessionId,
      epoch: () => screenOpeningEpoch,
      // The screen's legacy viewer, recorder and stills all hang off the frames the helper
      // socket feeds, so each unit goes in once whichever of them egress serves.
      consumers: { deliver: unit, record: unit, still: unit },
      point: (address) => {
        // Back on the helper socket (a route flip, ace-media gone): ace-media's views no longer
        // ask for anything.
        if (!address) void this.#owners.remove(mediaOwner).catch(() => {});
        return this.#point(address);
      },
      keyframe: () => void options.helper.request({ op: "stream.keyframe" }).catch(() => {}),
      // ace-media's end marker for a path, after its last unit.
      pathEnded: (path, interrupted) => this.#merge.ended(path, interrupted),
      // ace-media's plan for the views it delivers (D1): the helper runs one encode, the
      // largest wanted, held to what `stream.configure` takes.
      // One owner of the helper's stream beside the legacy viewers', removed when its plan is
      // empty: neither ever overwrites the other.
      want: (encodes) => {
        const settings = wantedStreamSettings(encodes);
        const update = settings
          ? this.#owners.set(mediaOwner, settings)
          : this.#owners.remove(mediaOwner);
        void update.catch(() => {});
      },
    });
    // Every helper encodes H.264 only (`wantedStreamSettings`), whatever a view prefers.
    this.#source.codecs([...h264Only]);
  }

  /** Whether the helper sends video to ace-media now (its stills then come only on request). */
  get ingesting(): boolean {
    return this.#onPath !== daemonPath;
  }

  /** Frames dropped as older than one already handed on, or lost to a cut path. */
  get stale(): number {
    return this.#stale + this.#merge.stale;
  }

  /** A frame off the helper's own socket. */
  daemonFrame(frame: Frame): void {
    if (this.#closed) return;
    // Stills always take the helper socket, whichever path video is on. They are ordered among
    // themselves, so a still arriving during a switch never makes held video stale.
    if (frame.header.codec === "jpeg") {
      if (frame.header.sequence > this.#lastStill) {
        this.#lastStill = frame.header.sequence;
        this.#options.accept(frame);
      } else this.#stale++;
      return;
    }
    this.#lastDaemonVideo = Math.max(this.#lastDaemonVideo, frame.header.sequence);
    this.#merge.deliver(daemonPath, frame);
    this.#daemonReached();
  }

  /**
   * The legacy viewers' stream request (`stream.configure`). It shares the helper's one stream
   * with ace-media's views through `StreamOwners`: the helper runs the stream both can take. A
   * request for JPEG ends the legacy viewers' live demand; it is what the helper runs once
   * nobody asks for video.
   */
  configure(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    if (settings.codec !== "h264") {
      this.#idle = settings;
      return this.#owners.has(legacyOwner)
        ? this.#owners.remove(legacyOwner)
        : this.#owners.refresh();
    }
    return this.#owners.set(legacyOwner, settings);
  }

  /** `stream.configure` with the current route's ingest and epoch. */
  #apply(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    this.#settings = settings;
    return this.#serial(async () => {
      try {
        return await this.#send(settings);
      } catch (error) {
        if (!this.#address) throw error;
        // ace-media's socket refused the helper: video stays on the daemon's.
        this.#address = undefined;
        const result = await this.#send(settings);
        this.#source.reconnect();
        return result;
      }
    });
  }

  /** The helper's ingest connection failed; it is back on the daemon's socket already. */
  ingestClosed(): void {
    if (this.#closed || this.#onPath === daemonPath) return;
    const lost = this.#onPath;
    this.#onPath = daemonPath;
    this.#address = undefined;
    // Units it had sent may be missing: video starts again at the helper's next keyframe.
    this.#merge.switching(daemonPath);
    this.#merge.ended(lost, true);
    this.#source.reconnect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#owners.close();
    this.#source.close();
    this.#merge.dispose();
  }

  #hand(frame: Frame): void {
    if (frame.header.sequence <= this.#lastVideo) {
      this.#stale++;
      return;
    }
    this.#lastVideo = frame.header.sequence;
    this.#options.accept(frame);
  }

  /** The helper socket has delivered its boundary: that path's end, in order. */
  #daemonReached(): void {
    const boundary = this.#daemonBoundary;
    if (boundary === undefined || this.#lastDaemonVideo < boundary) return;
    this.#daemonBoundary = undefined;
    this.#merge.ended(daemonPath, false);
  }

  #egress(unit: EgressUnit): void {
    if (this.#closed || unit === this.#lastUnit) return;
    this.#lastUnit = unit;
    const frame = egressScreenFrame(this.#options.sessionId, unit.frame);
    if (frame) this.#merge.deliver(unit.source, frame);
  }

  #point(address: IngestAddress | undefined): Promise<void> {
    return this.#serial(async () => {
      this.#address = address && {
        ingest: {
          socket: address.socket,
          token: Buffer.from(address.token).toString("base64"),
          ...(address.pid ? { pid: address.pid } : {}),
        },
        path: address.path,
      };
      // No live video yet: the next `stream.configure` carries the address.
      const settings = this.#settings;
      if (!settings || this.#closed) return;
      try {
        await this.#send(settings);
      } catch (error) {
        if (!address) throw error;
        this.#address = undefined;
        await this.#send(settings).catch(() => {});
        throw error;
      }
    });
  }

  async #send(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    const address = this.#address;
    const from = this.#onPath;
    const to = address ? address.path : daemonPath;
    if (to !== from) this.#merge.switching(to);
    let reply: ScreenStreamConfigured;
    try {
      reply = ScreenStreamConfigured.parse(
        await this.#options.helper.request({
          op: "stream.configure",
          // A Linux helper's video goes to ace-media only: on the daemon's path it sends the
          // JPEG pictures the daemon has always encoded itself.
          settings:
            address || !videoOnlyToMedia(this.#options) ? settings : { ...settings, codec: "jpeg" },
          epoch: screenOpeningEpoch,
          ...(address ? { ingest: address.ingest } : {}),
        }),
      );
    } catch (error) {
      // The helper didn't move: the switch is abandoned and the current path goes on.
      if (to !== from) this.#merge.switching(from);
      throw error;
    }
    const now = reply.ingest === "on" && address ? address.path : daemonPath;
    this.#onPath = now;
    if (now === from) {
      if (to !== from) this.#merge.switching(from);
    } else if (from === daemonPath) {
      // Off the helper socket: its end is its boundary arriving there. A path into ace-media
      // ends with ace-media's marker instead (`pathEnded`).
      const boundary = reply.switched ? (reply.boundary ?? null) : null;
      if (boundary === null) this.#merge.ended(daemonPath, false);
      else {
        this.#daemonBoundary = boundary;
        this.#daemonReached();
      }
    }
    return { codec: reply.codec };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => {});
    return run;
  }
}
