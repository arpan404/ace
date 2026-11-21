import type { EgressUnit } from "@ace/media/egress";
import {
  h264Only,
  type IngestAddress,
  type IngestProducer,
  type IngestSource,
  type Origin,
  type StopStatus,
} from "@ace/media/ingest-sources";
import { PathMerge } from "@ace/media/path-merge";
import { readProducerStamp } from "@ace/media/producer-stamp";
import type { SourceKind } from "@ace/media/routes";
import type { ScreenStreamSettings } from "@ace/protocol";
import { wantedStreamSettings } from "@ace/screen";
import type { VideoUnit } from "./scrcpy-video.ts";

/**
 * A device's video, which comes only through ace-media (ADR 0147, phase 2, E3, X2). Every unit
 * off egress goes through one shared `PathMerge`, so the capture downstream sees one ordered
 * stream across ace-media paths (a reconnect, a restart), and numbers its frames as before.
 *
 * Leaving a path, it ends with ace-media's end marker after its last unit. While the producer
 * isn't pointed at ace-media nothing streams; a producer whose ingest connection fails stops,
 * that path is cut, and video starts again at a keyframe on the next one.
 */

/** Where device sources are opened in ace-media: the daemon's shared sources. */
export type DeviceMedia = { attach(producer: IngestProducer): IngestSource };

/**
 * A device's media, with every producer it attaches carrying ace-media's plan for the device's
 * views (`source.want`, D1) to `want` as one stream request: a device runs one stream. `want`
 * gets undefined when that plan stops holding: an empty plan, the producer pointed back at the
 * daemon (a route flip, ace-media gone) or its source closed, so ace-media's budget never
 * outlives its last viewer.
 */
export function withMediaWant(
  media: DeviceMedia,
  want: (settings: ScreenStreamSettings | undefined) => void,
): DeviceMedia {
  return {
    attach: (producer) => {
      const source = media.attach({
        ...producer,
        want: (encodes) => want(wantedStreamSettings(encodes)),
        point: (address) => {
          if (!address) want(undefined);
          return producer.point(address);
        },
      });
      return {
        ...source,
        close: () => {
          want(undefined);
          source.close();
        },
      };
    },
  };
}

/** Why a device's video can't play now; undefined once a picture arrives again. */
export type DeviceVideoStatus = { status: StopStatus; reason: string } | undefined;

/**
 * A device's media whose producers report why their video stopped (ace-media restarting,
 * unavailable, or refusing the source), for the device's state (`DeviceState.video`). What
 * clears it is the session's own next picture, after the path merge, whichever source carried
 * it, so a source opened again never leaves an older reason standing.
 */
export function withVideoStatus(
  media: DeviceMedia,
  status: (video: DeviceVideoStatus) => void,
): DeviceMedia {
  return {
    attach: (producer) =>
      media.attach({
        ...producer,
        stopped: (reason, kind) => {
          status({ status: kind, reason });
          producer.stopped?.(reason, kind);
        },
      }),
  };
}

/**
 * The producer's answer to a switch: where it sends now, and the last sequence the previous
 * path took. `cut` instead: the paths carry the same live stream (serve-sim broadcasts one to
 * every subscription), so the previous path ends at the switch and the new one starts at a
 * fresh keyframe; older units still coming are superseded, never repeated.
 */
export type Switched = { ingest: "on" | "off"; boundary: number | null; cut?: boolean };

export type DeviceVideoPathsOptions = {
  media: DeviceMedia;
  source: string;
  kind: SourceKind;
  origin: Origin;
  deviceId: string;
  /** The capture's own handling of one unit, in order. */
  emit: (unit: VideoUnit) => void;
  /** Points the producer at ace-media (an address), or stops it. */
  switch: (address: IngestAddress | undefined) => Promise<Switched>;
  keyframe: () => void;
  schedule: (callback: () => void, milliseconds: number) => () => void;
};

/** The merge's name for "nothing streams": nothing is ever delivered on it. */
const offPath = "off";
const Keyframe = 1;

/** An egress unit as the capture's own video unit. */
export function egressVideoUnit(unit: EgressUnit, codec: string): VideoUnit | undefined {
  const frame = unit.frame;
  if (frame.kind !== 1 || frame.codec !== 1 || !frame.width || !frame.height) return undefined;
  const stamp = readProducerStamp(frame.extension);
  const keyframe = (frame.flags & Keyframe) !== 0;
  return {
    payload: Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength),
    keyframe,
    videoCodec: keyframe && frame.codecString ? frame.codecString : codec,
    width: frame.width,
    height: frame.height,
    pts: BigInt(Math.round((stamp?.timestamp ?? 0) * 1000)),
    encode: frame.encode,
  };
}

export class DeviceVideoPaths {
  readonly #options: DeviceVideoPathsOptions;
  readonly #merge: PathMerge<VideoUnit>;
  readonly #source: IngestSource;
  #onPath = offPath;
  /** The path the merge last moved to: stopping never moves it. */
  #mergeOn = offPath;
  /** Paths whose end has come (interrupted?): the merge moves on from them at once. */
  readonly #ended = new Map<string, boolean>([[offPath, false]]);
  #codec = "avc1.640033";
  #lastUnit: EgressUnit | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: DeviceVideoPathsOptions) {
    this.#options = options;
    this.#merge = new PathMerge<VideoUnit>(offPath, {
      emit: (unit) => {
        if (unit.keyframe) this.#codec = unit.videoCodec;
        options.emit(unit);
      },
      stream: () => "video",
      key: (unit) => unit.keyframe,
      bytes: (unit) => unit.payload.length,
      schedule: options.schedule,
    });
    const deliver = (egress: EgressUnit) => this.#egress(egress);
    this.#source = options.media.attach({
      source: options.source,
      kind: options.kind,
      origin: options.origin,
      deviceId: options.deviceId,
      epoch: () => 0,
      consumers: { deliver },
      point: (address) => this.#point(address),
      keyframe: () => options.keyframe(),
      pathEnded: (path, interrupted) => {
        this.#ended.set(path, interrupted);
        this.#merge.ended(path, interrupted);
        // Units may be missing: whatever comes next decodes only from a keyframe.
        if (interrupted) options.keyframe();
      },
    });
    // A device's stream is H.264 whatever its producer (scrcpy, serve-sim, the helper's frame
    // encoder), so a view that prefers HEVC is planned onto it.
    this.#source.codecs([...h264Only]);
  }

  /** Units dropped: from a path given up on, or deltas waiting for their keyframe. */
  get stale(): number {
    return this.#merge.stale;
  }

  /**
   * A keyframe while the source streams from ace-media: ace-media reads it, so it is asked.
   * False while nothing streams.
   */
  keyframe(): boolean {
    if (this.#closed || this.#onPath === offPath) return false;
    this.#source.key(0);
    return true;
  }

  /** The encodes ace-media runs for this source (a Simulator it re-encodes for a viewer). */
  encodes(encodes: Parameters<IngestSource["encodes"]>[0]): void {
    if (!this.#closed) this.#source.encodes(encodes);
  }

  /** The producer's ingest connection failed: it has stopped already. The source reopens. */
  ingestClosed(): void {
    if (this.#closed || this.#onPath === offPath) return;
    this.#onPath = offPath;
    this.#options.keyframe();
    this.#source.reconnect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#source.close();
    this.#merge.dispose();
  }

  #egress(unit: EgressUnit): void {
    if (this.#closed || unit === this.#lastUnit) return;
    this.#lastUnit = unit;
    const video = egressVideoUnit(unit, this.#codec);
    if (video) this.#merge.deliver(unit.source, video);
  }

  #point(address: IngestAddress | undefined): Promise<void> {
    const run = this.#tail.then(async () => {
      if (this.#closed) return;
      const to = address ? address.path : offPath;
      const switched = await this.#options.switch(address);
      if ((switched.ingest === "on") !== (to !== offPath))
        // It didn't move (an address it couldn't reach): nothing changes.
        throw new Error("The producer refused ace-media's ingest");
      this.#onPath = to;
      if (to === offPath || to === this.#mergeOn) return;
      const previous = this.#mergeOn;
      this.#mergeOn = to;
      this.#merge.switching(to);
      if (switched.cut) {
        // The paths carry the same live stream: the old one ends at the switch, and ace-media's
        // reader starts the new one at a keyframe of the picture as it is now.
        this.#merge.ended(previous, true);
        this.#source.key(0);
        return;
      }
      // Its units wait for the old path's marker (`pathEnded`), or go on at once from one
      // already ended, or from none.
      const end = this.#ended.get(previous);
      if (end !== undefined) this.#merge.ended(previous, end);
    });
    this.#tail = run.catch(() => {});
    return run;
  }
}
