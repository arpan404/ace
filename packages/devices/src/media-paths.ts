import type { EgressUnit } from "@ace/media/egress";
import type {
  IngestAddress,
  IngestProducer,
  IngestSource,
  Origin,
} from "@ace/media/ingest-sources";
import { PathMerge } from "@ace/media/path-merge";
import { readProducerStamp } from "@ace/media/producer-stamp";
import type { SourceKind } from "@ace/media/routes";
import type { VideoUnit } from "./scrcpy-video.ts";

/**
 * A device's video while it moves between the daemon's path and ace-media (ADR 0147, phase 2,
 * E3). Every unit goes through one shared `PathMerge`, so the capture downstream sees one
 * ordered stream whichever way it came, and numbers its frames as before.
 *
 * Leaving the daemon's path, that path ends once the producer's boundary (the last sequence it
 * sent there) has been handed on. Leaving ace-media, the old path ends with ace-media's end
 * marker after its last unit. A producer whose ingest connection fails is back on the daemon's
 * path at once; that path is cut, and video starts again at its next keyframe.
 */

/** Where device sources are opened in ace-media: the daemon's shared sources. */
export type DeviceMedia = { attach(producer: IngestProducer): IngestSource };

/**
 * The producer's answer to a switch: where it sends now, and the last sequence the previous
 * path took. `cut` instead: the paths carry the same live stream (serve-sim broadcasts one to
 * every subscription), so the previous path ends at the switch and the new one starts at a
 * fresh keyframe; older units still coming are superseded, never repeated.
 */
export type Switched = { ingest: "on" | "off"; boundary: number | null; cut?: boolean };

/** A unit on the daemon's path, with the producer's own sequence for the switch boundary. */
export type DaemonUnit = VideoUnit & { sequence: number };

export type DeviceVideoPathsOptions = {
  media: DeviceMedia;
  source: string;
  kind: SourceKind;
  origin: Origin;
  deviceId: string;
  /** The capture's own handling of one unit, in order. */
  emit: (unit: VideoUnit) => void;
  /** Points the producer at ace-media (an address) or back at the daemon. */
  switch: (address: IngestAddress | undefined) => Promise<Switched>;
  keyframe: () => void;
  schedule: (callback: () => void, milliseconds: number) => () => void;
};

const daemonPath = "daemon";
const Keyframe = 1;

/** An egress unit as the unit its producer's daemon path would have carried. */
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
  #onPath = daemonPath;
  #daemonBoundary: number | undefined;
  #lastDaemon = -1;
  #codec = "avc1.640033";
  #lastUnit: EgressUnit | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: DeviceVideoPathsOptions) {
    this.#options = options;
    this.#merge = new PathMerge<VideoUnit>(daemonPath, {
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
      consumers: { deliver, record: deliver, still: deliver },
      point: (address) => this.#point(address),
      keyframe: () => options.keyframe(),
      pathEnded: (path, interrupted) => {
        this.#merge.ended(path, interrupted);
        // Units may be missing: whatever comes next decodes only from a keyframe.
        if (interrupted) options.keyframe();
      },
    });
  }

  /** Units dropped: from a path given up on, or deltas waiting for their keyframe. */
  get stale(): number {
    return this.#merge.stale;
  }

  /** A unit on the daemon's path. */
  daemon(unit: DaemonUnit): void {
    if (this.#closed) return;
    this.#lastDaemon = Math.max(this.#lastDaemon, unit.sequence);
    this.#merge.deliver(daemonPath, unit);
    this.#reached();
  }

  /**
   * A keyframe while the source streams from ace-media: ace-media reads it, so it is asked.
   * False on the daemon's path, where the capture asks its own producer.
   */
  keyframe(): boolean {
    if (this.#closed || this.#onPath === daemonPath) return false;
    this.#source.key(0);
    return true;
  }

  /** The encodes ace-media runs for this source (a Simulator it re-encodes for a viewer). */
  encodes(encodes: Parameters<IngestSource["encodes"]>[0]): void {
    if (!this.#closed) this.#source.encodes(encodes);
  }

  /** The producer's ingest connection failed: it is on the daemon's path again already. */
  ingestClosed(): void {
    if (this.#closed || this.#onPath === daemonPath) return;
    const lost = this.#onPath;
    this.#onPath = daemonPath;
    this.#merge.switching(daemonPath);
    this.#merge.ended(lost, true);
    this.#options.keyframe();
    this.#source.reconnect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#source.close();
    this.#merge.dispose();
  }

  #reached(): void {
    const boundary = this.#daemonBoundary;
    if (boundary === undefined || this.#lastDaemon < boundary) return;
    this.#daemonBoundary = undefined;
    this.#merge.ended(daemonPath, false);
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
      const from = this.#onPath;
      const to = address ? address.path : daemonPath;
      if (to !== from) this.#merge.switching(to);
      let switched: Switched;
      try {
        switched = await this.#options.switch(address);
      } catch (error) {
        if (to !== from) this.#merge.switching(from);
        throw error;
      }
      if ((switched.ingest === "on") !== (to !== daemonPath)) {
        // It didn't move (an address it couldn't reach): the switch is abandoned.
        if (to !== from) this.#merge.switching(from);
        throw new Error("The producer refused ace-media's ingest");
      }
      this.#onPath = to;
      if (switched.cut) {
        this.#merge.ended(from, true);
        // ace-media's reader starts the new path at a keyframe of the picture as it is now.
        if (to !== daemonPath) this.#source.key(0);
        return;
      }
      // Off the daemon's path: its end is its boundary arriving. Out of ace-media, the path ends
      // with ace-media's marker instead (`pathEnded`).
      if (from === daemonPath && to !== daemonPath) {
        if (switched.boundary === null) this.#merge.ended(daemonPath, false);
        else {
          this.#daemonBoundary = switched.boundary;
          this.#reached();
        }
      }
    });
    this.#tail = run.catch(() => {});
    return run;
  }
}
