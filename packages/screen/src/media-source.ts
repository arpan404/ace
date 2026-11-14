import type { EgressUnit } from "@ace/media/egress";
import type { MediaFrame } from "@ace/media/frame";
import type { IngestAddress, IngestProducer, IngestSource } from "@ace/media/ingest-sources";
import { readProducerStamp } from "@ace/media/producer-stamp";
import {
  ScreenStreamConfigured,
  type ScreenStreamIngest,
  type ScreenStreamSettings,
} from "@ace/protocol";
import { wireFrame, type Frame } from "./frames.ts";
import type { HelperPort } from "./helper-session.ts";
import { PathMerge } from "@ace/media/path-merge";

/**
 * A Mac screen session as an ace-media producer (docs/media/plan.md, E3). When the route sends
 * screens to ace-media, the helper is given the ingest socket with each `stream.configure` and
 * writes its H.264 there; ace-media's egress brings the units back as the frames the helper's
 * socket would have carried, header for header, for the daemon's legacy viewer, recorder and
 * stills. Both paths go through one ordered merge, so a route change loses or repeats nothing.
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

export type ScreenMediaSourceOptions = {
  sessionId: string;
  helper: HelperPort;
  media: ScreenMedia;
  /** A frame from either path, video in sequence order and stills in theirs. */
  accept: (frame: Frame) => void;
  schedule: (callback: () => void, milliseconds: number) => () => void;
};

const daemonPath = "daemon";

export class ScreenMediaSource {
  readonly #options: ScreenMediaSourceOptions;
  /** Video only: it is what moves between the helper socket and ace-media. */
  readonly #merge: PathMerge<Frame>;
  readonly #source: IngestSource;
  #settings: ScreenStreamSettings | undefined;
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
      origin: { kind: "screen", platform: "macos" },
      sessionId: options.sessionId,
      epoch: () => screenOpeningEpoch,
      // The screen's legacy viewer, recorder and stills all hang off the frames the helper
      // socket feeds, so each unit goes in once whichever of them egress serves.
      consumers: { deliver: unit, record: unit, still: unit },
      point: (address) => this.#point(address),
      keyframe: () => void options.helper.request({ op: "stream.keyframe" }).catch(() => {}),
      // ace-media's end marker for a path, after its last unit.
      pathEnded: (path, interrupted) => this.#merge.ended(path, interrupted),
    });
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

  /** `stream.configure` with the current route's ingest and epoch. */
  configure(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
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
        ingest: { socket: address.socket, token: Buffer.from(address.token).toString("base64") },
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
          settings,
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
