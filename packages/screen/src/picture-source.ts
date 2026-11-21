import { annexB, avcConfig, type AvcConfig } from "@ace/browser/h264";
import type { EgressUnit } from "@ace/media/egress";
import type {
  IngestAddress,
  IngestProducer,
  IngestSource,
  StopStatus,
} from "@ace/media/ingest-sources";
import {
  IngestWriter,
  stillPictureFrame,
  type IngestWriterOptions,
} from "@ace/media/ingest-writer";
import type { ScreenStreamSettings } from "@ace/protocol";
import { wireFrame, type Frame } from "./frames.ts";
import type { HelperPort } from "./helper-session.ts";
import { screenOpeningEpoch, wantedStreamSettings, type ScreenMedia } from "./media-source.ts";

/**
 * A screen whose helper makes only JPEG (Windows without a working Media Foundation H.264
 * encoder, Linux where every encoder failed its trial) as an ace-media picture source (X2,
 * ADR 0148): its pictures go to ace-media on the source's own ingest connection, as binary
 * still-picture frames (bounded by the writer: past its budget only the newest picture waits,
 * and one too large to send is dropped and counted), ace-media encodes them on this
 * computer's encoder (its last resort where nothing else works), and the units come back on
 * egress as the session's video. Its stills stay as they are. If no encoder works, ace-media
 * ends the source with its reason, which the session shows.
 */

/** The largest even size at or below `value`, at least 64, as hardware encoders take. */
const even = (value: number) => Math.max(64, Math.floor(value / 2) * 2);

/** The encode a viewer's request comes to for pictures of this size: inside its box, even. */
export function pictureEncode(
  picture: { width: number; height: number },
  settings: Pick<ScreenStreamSettings, "maxWidth" | "maxHeight" | "fps" | "bitrate">,
) {
  const fit = Math.min(1, settings.maxWidth / picture.width, settings.maxHeight / picture.height);
  return {
    id: 1,
    codec: "avc1.42E033",
    width: even(picture.width * fit),
    height: even(picture.height * fit),
    fps: Math.max(1, Math.round(settings.fps)),
    bitrate: Math.max(1, Math.round(settings.bitrate)),
  };
}

export type ScreenPictureSourceOptions = {
  sessionId: string;
  platform: string;
  helper: HelperPort;
  media: ScreenMedia;
  /** A frame: video off egress in its own order, and the helper's stills in theirs. */
  accept: (frame: Frame) => void;
  /** Why the video stopped, or (undefined) that a picture arrived again. */
  stalled?: (status: { status: StopStatus; reason: string } | undefined) => void;
  now: () => number;
  /** The ingest connection, for tests; a real socket otherwise. */
  connect?: IngestWriterOptions["connect"];
};

type Want = Parameters<NonNullable<IngestProducer["want"]>>[0];

export class ScreenPictureSource {
  readonly #options: ScreenPictureSourceOptions;
  readonly #source: IngestSource;
  #streaming = false;
  #closed = false;
  #stalled = false;
  /** The last picture's size and scale, which the encodes and frame headers follow. */
  #picture: { width: number; height: number; scale: number } | undefined;
  /** The viewers' request, and ace-media's plan for the views it delivers (its own ids). */
  #viewer: ScreenStreamSettings | undefined;
  #planned: Want | undefined;
  /** The connection the pictures go on, while ace-media holds the source. */
  #writer: IngestWriter | undefined;
  #dropped = 0;
  #lastStill = -1;
  #sequence = 0;
  #sent = "";
  /** The encode's avcC, from its last keyframe: AVCC units become Annex B with it. */
  #config: AvcConfig | undefined;

  constructor(options: ScreenPictureSourceOptions) {
    this.#options = options;
    const unit = (egress: EgressUnit) => this.#egress(egress);
    this.#source = options.media.add({
      source: `screen-pictures:${options.sessionId}`,
      kind: "screen-pictures",
      origin: { kind: "screen-pictures", platform: options.platform },
      sessionId: options.sessionId,
      epoch: () => screenOpeningEpoch,
      consumers: { deliver: unit },
      point: (address) => {
        this.#point(address);
        return Promise.resolve();
      },
      keyframe: () => this.keyframe(),
      stopped: (reason, status) => {
        this.#stalled = true;
        options.stalled?.({ status, reason });
      },
      // ace-media's plan for the views it delivers: its encodes, under its ids, and the helper's
      // pictures at the size and rate the largest needs.
      want: (encodes) => {
        this.#planned = encodes.length ? encodes : undefined;
        this.#encode();
        const settings = wantedStreamSettings(encodes);
        if (settings && !this.#viewer)
          void options.helper
            .request({ op: "stream.configure", settings: { ...settings, codec: "jpeg" } })
            .catch(() => {});
      },
    });
  }

  /** The helper sends pictures to ace-media only while ace-media holds the source. */
  get ingesting(): boolean {
    return this.#streaming;
  }

  get stale(): number {
    return 0;
  }

  /** Pictures too large to send, dropped rather than failing the helper. */
  get dropped(): number {
    return this.#dropped;
  }

  /** A still off the helper's socket: the session's, and ace-media's next picture to encode. */
  daemonFrame(frame: Frame): void {
    if (this.#closed || frame.header.codec !== "jpeg") return;
    if (frame.header.sequence <= this.#lastStill) return;
    this.#lastStill = frame.header.sequence;
    this.#options.accept(frame);
    const first = this.#picture === undefined;
    this.#picture = {
      width: frame.header.width,
      height: frame.header.height,
      scale: frame.header.scale ?? 1,
    };
    if (first) this.#encode();
    const writer = this.#writer;
    if (!writer || !(this.#viewer || this.#planned)) return;
    const picture = stillPictureFrame(frame.payload, frame.header, screenOpeningEpoch);
    if (!picture) {
      this.#dropped++;
      return;
    }
    writer.write(picture);
  }

  #point(address: IngestAddress | undefined): void {
    // Every unit the old connection holds goes before its end; a new one starts afresh.
    this.#writer?.finish();
    this.#writer = undefined;
    this.#streaming = address !== undefined;
    if (!address || this.#closed) {
      address?.token.fill(0);
      return;
    }
    const writer: IngestWriter = new IngestWriter({
      socket: address.socket,
      token: address.token,
      onClosed: () => {
        if (this.#writer !== writer) return;
        this.#writer = undefined;
        this.#streaming = false;
        this.#source.reconnect();
      },
      onKeyframe: () => {},
      ...(this.#options.connect ? { connect: this.#options.connect } : {}),
    });
    this.#writer = writer;
  }

  /**
   * The viewers' stream request: the helper sends JPEG at its rate and size, which ace-media
   * encodes. Video is what the viewer gets, once ace-media has the source.
   */
  async configure(settings: ScreenStreamSettings): Promise<{ codec: "jpeg" | "h264" }> {
    this.#viewer = settings.codec === "h264" ? settings : undefined;
    this.#encode();
    await this.#options.helper.request({
      op: "stream.configure",
      settings: { ...settings, codec: "jpeg" },
    });
    return { codec: settings.codec === "h264" ? "h264" : "jpeg" };
  }

  /** ace-media's next unit of each running encode is a keyframe. */
  keyframe(): void {
    for (const encode of this.#encodes()) this.#source.key(encode.id);
  }

  recodec(): Promise<void> {
    return Promise.resolve();
  }

  ingestClosed(): void {}

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#writer?.close();
    this.#writer = undefined;
    this.#source.close();
  }

  /** ace-media's plan when it has one; else the viewer's request, once a picture sized it. */
  #encodes() {
    if (this.#planned) return this.#planned;
    const picture = this.#picture;
    return this.#viewer && picture ? [pictureEncode(picture, this.#viewer)] : [];
  }

  #encode(): void {
    const encodes = this.#encodes();
    const key = JSON.stringify(encodes);
    if (key === this.#sent) return;
    this.#sent = key;
    this.#source.encodes(encodes);
  }

  #egress(unit: EgressUnit): void {
    const { frame } = unit;
    const picture = this.#picture;
    if (this.#closed || frame.kind !== 1 || !frame.width || !frame.height || !picture) return;
    const keyframe = (frame.flags & 1) !== 0;
    try {
      // Viewers of a screen decode Annex B with the parameter sets on each keyframe, as the
      // helpers write it; ace-media's own encodes come length-prefixed with their avcC.
      let payload = Buffer.from(
        frame.payload.buffer,
        frame.payload.byteOffset,
        frame.payload.byteLength,
      );
      if (frame.codec === 2) {
        if (keyframe && frame.description.length)
          this.#config = avcConfig(Buffer.from(frame.description));
        const config = this.#config;
        if (!config) return;
        payload = annexB(payload, config, keyframe);
      } else if (frame.codec !== 1) return;
      const out = wireFrame(
        {
          version: 2,
          sessionId: this.#options.sessionId,
          seq: ++this.#sequence,
          ts: this.#options.now(),
          width: frame.width,
          height: frame.height,
          // Pixels per point, as the helper's pictures say, at the encoded size.
          scale: (picture.scale * frame.width) / picture.width,
          codec: "h264",
          keyframe,
          ...(keyframe && frame.codecString ? { videoCodec: frame.codecString } : {}),
          bytes: payload.length,
        },
        payload,
      );
      if (this.#stalled) {
        this.#stalled = false;
        this.#options.stalled?.(undefined);
      }
      this.#options.accept(out);
    } catch {
      // A unit the frame header can't carry is dropped; the next keyframe starts again.
    }
  }
}
