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
  type ScreenHelperStreamSettings,
  type ScreenStreamIngest,
  type ScreenStreamSettings,
} from "@ace/protocol";
import { wireFrame, type Frame } from "./frames.ts";
import type { HelperPort } from "./helper-session.ts";
import { StreamOwners } from "./stream-owners.ts";
import { PathMerge } from "@ace/media/path-merge";
import { helperEncodesHevc, hevcMain, wantedCodec } from "./helper-codecs.ts";

/**
 * A Mac, Windows or Linux screen session as an ace-media producer (docs/media/plan.md, E3, E1,
 * E2, X2). ace-media is the only place its video goes: the helper is given the ingest socket
 * with each `stream.configure` and writes its H.264 there (a Mac whose HEVC trial worked writes
 * HEVC while ace-media's views all want it and nobody on the daemon's side needs H.264). Without
 * an ingest the helper runs stills only. ace-media's egress brings the units back as the frames
 * the helper's socket used to carry, header for header, for the daemon's legacy viewer, recorder
 * and stills; the helper's socket carries only stills. Each ace-media path (a reconnect, a
 * restart) goes through one ordered merge, so moving between them loses or repeats nothing.
 */

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
  /** The helper's platform, as its hello names it (`macos`, `windows`, `linux-wayland`): ace-media's origin. */
  platform: string;
  /** The codecs the helper's hello lists (`codecs`): `hevc` on a Mac whose HEVC trial worked. */
  codecs?: readonly string[];
  /** The daemon itself needs the screen's video as H.264 (a recording of the frames egress
   * hands back), so the helper's stream stays H.264 whatever ace-media's views prefer. */
  daemonNeedsVideo?: () => boolean;
  helper: HelperPort;
  media: ScreenMedia;
  /** A frame: video off egress in sequence order, stills off the helper's socket in theirs. */
  accept: (frame: Frame) => void;
  schedule: (callback: () => void, milliseconds: number) => () => void;
};

/** The merge's name for "video goes nowhere": nothing is ever delivered on it. */
const offPath = "off";
/** The two demands on the helper's stream. */
const legacyOwner = "legacy";
const mediaOwner = "ace-media";

export class ScreenMediaSource {
  readonly #options: ScreenMediaSourceOptions;
  /** Video only: it is what moves between ace-media paths. */
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
  /** Where the helper sends video now: an ace-media path, or nowhere. */
  #onPath = offPath;
  /** The paths whose end has come (interrupted?): the merge moves on from them at once. */
  readonly #ended = new Map<string, boolean>([[offPath, false]]);
  /** The path the merge last moved to: video stopping never moves it. */
  #mergeOn = offPath;
  /** The last video and still handed on: each keeps its own order. */
  #lastVideo = -1;
  #lastStill = -1;
  #stale = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #lastUnit: EgressUnit | undefined;
  #closed = false;
  /** The helper encodes HEVC toward ace-media (`helperEncodesHevc`). */
  readonly #hevc: boolean;
  /** What ace-media's plan wants, as `wantedCodec` reads it. */
  #mediaCodec: "h264" | "hevc" = "h264";
  /** The video codec last sent to the helper. */
  #sentCodec: ScreenHelperStreamSettings["codec"] | undefined;

  constructor(options: ScreenMediaSourceOptions) {
    this.#options = options;
    this.#hevc = helperEncodesHevc({ platform: options.platform, codecs: options.codecs ?? [] });
    this.#merge = new PathMerge<Frame>(offPath, {
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
        // ace-media is gone: its views no longer ask for anything, and the helper runs stills.
        if (!address) void this.#owners.remove(mediaOwner).catch(() => {});
        return this.#point(address);
      },
      keyframe: () => void options.helper.request({ op: "stream.keyframe" }).catch(() => {}),
      // ace-media's end marker for a path, after its last unit.
      pathEnded: (path, interrupted) => this.#pathEnded(path, interrupted),
      // ace-media's plan for the views it delivers (D1): the helper runs one encode, the
      // largest wanted, held to what `stream.configure` takes.
      // One owner of the helper's stream beside the legacy viewers', removed when its plan is
      // empty: neither ever overwrites the other.
      want: (encodes) => {
        const settings = wantedStreamSettings(encodes);
        this.#mediaCodec = wantedCodec(encodes);
        const update = settings
          ? this.#owners.set(mediaOwner, settings)
          : this.#owners.remove(mediaOwner);
        void update.then(() => this.recodec()).catch(() => {});
      },
    });
    // H.264 first: ace-media plans each view in the first of its own codecs the helper encodes.
    this.#source.codecs(this.#hevc ? [...h264Only, hevcMain] : [...h264Only]);
  }

  /**
   * Whether the helper's video should go out in HEVC: it encodes it, ace-media's views all want
   * it, video goes to ace-media now, and nobody on the daemon's side needs H.264 (a legacy
   * viewer, a recording). The stream is shared, so any of those keeps it H.264.
   */
  #wantsHevc(): boolean {
    return (
      this.#hevc &&
      this.#mediaCodec === "hevc" &&
      this.#address !== undefined &&
      this.#owners.has(mediaOwner) &&
      !this.#owners.has(legacyOwner) &&
      this.#options.daemonNeedsVideo?.() !== true
    );
  }

  /**
   * Sends the current stream again when its codec should change (a legacy viewer came or left,
   * a recording started or stopped, ace-media's plan changed codec) and its size didn't.
   */
  recodec(): Promise<void> {
    return this.#serial(async () => {
      const settings = this.#settings;
      if (!settings || settings.codec === "jpeg" || this.#closed) return;
      if (this.#wire(settings).codec === this.#sentCodec) return;
      await this.#send(settings);
    });
  }

  /** The request the helper gets for `settings` on the current route: without an ace-media
   * address there is nowhere for video to go, so the helper runs stills. */
  #wire(settings: ScreenStreamSettings): ScreenHelperStreamSettings {
    if (!this.#address) return { ...settings, codec: "jpeg" };
    return settings.codec === "h264" && this.#wantsHevc()
      ? { ...settings, codec: "hevc" }
      : settings;
  }

  /** Whether the helper sends video to ace-media now (its stills then come only on request). */
  get ingesting(): boolean {
    return this.#onPath !== offPath;
  }

  /** Frames dropped as older than one already handed on, or lost to a cut path. */
  get stale(): number {
    return this.#stale + this.#merge.stale;
  }

  /** A still off the helper's own socket; video never comes that way. */
  daemonFrame(frame: Frame): void {
    if (this.#closed || frame.header.codec !== "jpeg") return;
    // Stills are ordered among themselves, so a still arriving during a switch never makes held
    // video stale.
    if (frame.header.sequence > this.#lastStill) {
      this.#lastStill = frame.header.sequence;
      this.#options.accept(frame);
    } else this.#stale++;
  }

  /**
   * The legacy viewers' stream request (`stream.configure`). It shares the helper's one stream
   * with ace-media's views through `StreamOwners`: the helper runs the stream both can take. A
   * request for JPEG ends the legacy viewers' live demand; it is what the helper runs once
   * nobody asks for video.
   */
  async configure(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    let result: { codec: "jpeg" | "h264" };
    if (settings.codec !== "h264") {
      this.#idle = settings;
      result = await (this.#owners.has(legacyOwner)
        ? this.#owners.remove(legacyOwner)
        : this.#owners.refresh());
    } else result = await this.#owners.set(legacyOwner, settings);
    // A legacy viewer decodes H.264 only: the stream is H.264 before its request returns.
    await this.recodec();
    // Video is on its way once ace-media takes the source, whatever the helper runs meanwhile.
    return settings.codec === "h264" ? { codec: "h264" } : result;
  }

  /** `stream.configure` with the current route's ingest and epoch. */
  #apply(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    this.#settings = settings;
    return this.#serial(async () => {
      try {
        return await this.#send(settings);
      } catch (error) {
        if (!this.#address) throw error;
        // ace-media's socket refused the helper: stills until the source is opened again.
        this.#address = undefined;
        const result = await this.#send(settings);
        this.#source.reconnect();
        return result;
      }
    });
  }

  /** The helper's ingest connection failed; its video has stopped already. */
  ingestClosed(): void {
    if (this.#closed || this.#onPath === offPath) return;
    this.#onPath = offPath;
    this.#address = undefined;
    // Units it had sent may be missing: the next path starts at the helper's next keyframe once
    // ace-media's marker for this one comes. The source is opened again.
    this.#source.reconnect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // close() waits for the running update with its failure already swallowed.
    void this.#owners.close().catch(() => {});
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

  /** ace-media's end marker for a path, after its last unit. */
  #pathEnded(path: string, interrupted: boolean): void {
    this.#ended.set(path, interrupted);
    this.#merge.ended(path, interrupted);
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
    const sent = this.#wire(settings);
    // A helper that doesn't move leaves the current path going on.
    const reply = ScreenStreamConfigured.parse(
      await this.#options.helper.request({
        op: "stream.configure",
        settings: sent,
        epoch: screenOpeningEpoch,
        ...(address ? { ingest: address.ingest } : {}),
      }),
    );
    const now = reply.ingest === "on" && address ? address.path : offPath;
    this.#onPath = now;
    this.#sentCodec = sent.codec;
    if (now !== from && now !== offPath && now !== this.#mergeOn) {
      // Onto a new ace-media path: its units wait for the old path's marker (`pathEnded`), or
      // go on at once from one already ended, or from none.
      const previous = this.#mergeOn;
      this.#mergeOn = now;
      this.#merge.switching(now);
      const end = this.#ended.get(previous);
      if (end !== undefined) this.#merge.ended(previous, end);
    }
    // The daemon's side sees video either way: HEVC goes to ace-media's views only.
    return { codec: reply.codec === "jpeg" ? "jpeg" : "h264" };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => {});
    return run;
  }
}
