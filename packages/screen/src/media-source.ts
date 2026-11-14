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
import { PathMerge } from "./media-path-merge.ts";

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
  /** A frame in sequence order, from either path: what the helper socket's frames feed. */
  accept: (frame: Frame) => void;
  schedule: (callback: () => void, milliseconds: number) => () => void;
};

export class ScreenMediaSource {
  readonly #options: ScreenMediaSourceOptions;
  readonly #merge: PathMerge<Frame>;
  readonly #source: IngestSource;
  #settings: ScreenStreamSettings | undefined;
  #address: ScreenStreamIngest | undefined;
  #ingestOn = false;
  #tail: Promise<unknown> = Promise.resolve();
  #lastUnit: EgressUnit | undefined;
  #closed = false;

  constructor(options: ScreenMediaSourceOptions) {
    this.#options = options;
    this.#merge = new PathMerge({
      sequence: (frame) => frame.header.sequence,
      emit: (frame) => options.accept(frame),
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
    });
  }

  /** A frame off the helper's own socket. */
  daemonFrame(frame: Frame): void {
    if (!this.#closed) this.#merge.frame("daemon", frame);
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
    if (this.#closed || !this.#ingestOn) return;
    this.#ingestOn = false;
    this.#address = undefined;
    this.#merge.mediaClosed();
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
    const frame = egressScreenFrame(this.#options.sessionId, unit.frame);
    if (frame) this.#merge.frame("media", frame);
  }

  #point(address: IngestAddress | undefined): Promise<void> {
    return this.#serial(async () => {
      this.#address = address && {
        socket: address.socket,
        token: Buffer.from(address.token).toString("base64"),
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
    const wantOn = address !== undefined;
    if (wantOn !== this.#ingestOn) this.#merge.switching(wantOn ? "media" : "daemon");
    let reply: ScreenStreamConfigured;
    try {
      reply = ScreenStreamConfigured.parse(
        await this.#options.helper.request({
          op: "stream.configure",
          settings,
          epoch: screenOpeningEpoch,
          ...(address ? { ingest: address } : {}),
        }),
      );
    } catch (error) {
      this.#merge.unchanged();
      throw error;
    }
    this.#ingestOn = reply.ingest === "on";
    if (reply.switched)
      this.#merge.switched(this.#ingestOn ? "media" : "daemon", reply.boundary ?? null);
    else this.#merge.unchanged();
    return { codec: reply.codec };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => {});
    return run;
  }
}
