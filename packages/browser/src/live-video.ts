import { AudioFanout, listens, type AudioSink } from "./audio-fanout.ts";
import type {
  BrowserCdp,
  EncodedAudio,
  EncodedChunk,
  VideoCaptureHandle,
  VideoHost,
} from "./backend.ts";
import type { CaptureViewer } from "./capture-policy.ts";
import { LinkRate } from "./link-rate.ts";
import { PictureScale } from "./video-scale.ts";
import type { BrowserAudioChunk } from "./stream-audio.ts";
import type { BrowserVideoChunk } from "./stream-video.ts";
import { VideoFanout, type VideoSink } from "./video-fanout.ts";
import {
  maxBitrate,
  minBitrate,
  planVideo,
  videoFps,
  viewerPicture,
  type VideoEncode,
} from "./video-policy.ts";

/*
 * One thread's live video (ADR 0088): which viewers take video, the tab capture and its encodes,
 * and the chunks to each viewer; and the tab's sound to the viewers that unmuted it. The live
 * capture ticks it every 100 ms and tells it which tab it shows; the plan and the drop rules are
 * pure (`video-policy.ts`, `video-fanout.ts`, `audio-fanout.ts`), this holds the state between
 * them and the browser's encoder.
 */

/** Where the shown tab's video comes from: absent for a backend without an encoder. */
export interface LiveVideoSource {
  host: VideoHost;
  page: BrowserCdp;
}

/** Codecs asked of the encoder, whatever viewers prefer; a viewer's order picks among them. */
const knownCodecs = ["avc1.42E033", "vp09.00.41.08", "vp8"];
/** A capture size change waits for the pane to stop moving. */
const settleMs = 300;
/** After the encoder failed to start, try again this much later. */
const retryMs = 5_000;
/** Where a new viewer's bit rate starts, before its link has shown what it carries. */
const initialBitrate = 4_000_000;
/** An encode's bit rate changes in place when it moves this much, at most this often. */
const bitrateChange = 0.1;
const bitrateEveryMs = 400;

interface Viewer {
  capture: CaptureViewer;
  link: LinkRate;
  scale: PictureScale;
}

interface Capture {
  handle: VideoCaptureHandle;
  width: number;
  height: number;
}

export class LiveVideo {
  readonly fanout: VideoFanout<BrowserVideoChunk>;
  private now: () => number;
  private viewers = new Map<string, Viewer>();
  private source: LiveVideoSource | undefined;
  private tabId: string | undefined;
  private page = { width: 1280, height: 720, scale: 1 };
  private codecs: string[] | undefined;
  private failedCodecs = new Set<string>();
  private capture: Capture | undefined;
  private opening = false;
  private retryAt = -Infinity;
  private wanted: { width: number; height: number; since: number } | undefined;
  private encodes = "";
  /** The bit rate each running encode was last given. */
  private bitrates = new Map<string, number>();
  private bitratesAt = -Infinity;
  private owedKeys = new Set<string>();
  private sequence = 0;
  private generation = 0;
  private sound = new AudioFanout<BrowserAudioChunk>();
  private soundSinks = new Map<string, AudioSink<BrowserAudioChunk>>();
  /** What the open capture was last told about its sound (a capture starts with it off). */
  private soundOn = false;
  private soundSequence = 0;
  constructor(options: {
    now: () => number;
    /** A viewer started or stopped showing video. */
    playing(id: string, playing: boolean): void;
  }) {
    this.now = options.now;
    this.fanout = new VideoFanout<BrowserVideoChunk>({
      keyframe: (encode) => this.owedKeys.add(encode),
      playing: options.playing,
      sent: (id, sequence, bytes) => this.viewers.get(id)?.link.sent(sequence, bytes, this.now()),
      dropped: (id) => this.viewers.get(id)?.link.dropped(this.now()),
    });
  }
  /** A viewer that asked for video, or its new pane; `audio` takes the sound once it unmutes. */
  add(
    id: string,
    sink: VideoSink<BrowserVideoChunk>,
    capture: CaptureViewer,
    audio?: AudioSink<BrowserAudioChunk>,
  ): void {
    if (!capture.video) return;
    if (!this.fanout.has(id)) this.fanout.add(id, sink);
    if (audio) this.soundSinks.set(id, audio);
    this.listen(id, capture);
    const existing = this.viewers.get(id);
    this.viewers.set(id, {
      capture,
      link:
        existing?.link ??
        new LinkRate({ min: minBitrate, max: maxBitrate, initial: initialBitrate }),
      scale: existing?.scale ?? new PictureScale(),
    });
  }
  configure(id: string, capture: CaptureViewer): void {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    viewer.capture = capture;
    this.listen(id, capture);
  }
  remove(id: string): void {
    this.viewers.delete(id);
    this.fanout.remove(id);
    this.sound.remove(id);
    this.soundSinks.delete(id);
  }
  private listen(id: string, capture: CaptureViewer): void {
    const sink = this.soundSinks.get(id);
    this.sound.set(id, sink && listens(capture) ? sink : undefined);
  }
  has(id: string): boolean {
    return this.viewers.has(id);
  }
  /** The screencast size an open capture fed by pictures needs; undefined: none needed. */
  pictures(): { width: number; height: number } | undefined {
    const pictures = this.capture?.handle.pictures;
    return pictures ? { width: pictures.width, height: pictures.height } : undefined;
  }
  /** One screencast frame for a capture fed by pictures. */
  picture(base64: string): void {
    this.capture?.handle.pictures?.push(base64);
  }
  acknowledge(id: string, sequence: number): void {
    this.viewers.get(id)?.link.acknowledged(sequence, this.now());
    this.fanout.acknowledge(id, sequence);
  }
  keyframe(id: string): void {
    this.fanout.keyframe(id);
  }
  /** The capture shows this tab now (or nothing, without a source). */
  attach(
    source: LiveVideoSource | undefined,
    tabId: string | undefined,
    page: { width: number; height: number; scale: number },
  ): void {
    this.detach();
    this.source = source;
    this.tabId = tabId;
    this.page = page;
    this.retryAt = -Infinity;
  }
  /** Stops the tab's capture; viewers keep their last picture until the next `attach`. */
  detach(): void {
    this.generation++;
    this.capture?.handle.close();
    this.capture = undefined;
    this.source = undefined;
    this.encodes = "";
    this.soundOn = false;
    this.wanted = undefined;
    this.owedKeys.clear();
    this.fanout.stopAll();
  }
  clear(): void {
    this.detach();
    this.fanout.clear();
    this.sound.clear();
    this.soundSinks.clear();
    this.viewers.clear();
  }
  /** Re-plans the encodes from each viewer's pane and link, and applies them. `page` is the page's CSS size now. */
  tick(page: { width: number; height: number }): void {
    const now = this.now();
    this.fanout.flush();
    this.page = { ...this.page, ...page };
    const source = this.source;
    if (!source || !this.viewers.size) {
      if (this.capture) this.close();
      return;
    }
    if (this.codecs === undefined) return this.probe(source, now);
    const plan = planVideo(
      {
        ...this.page,
        codecs: this.codecs.filter((codec) => !this.failedCodecs.has(codec)),
      },
      [...this.viewers].map(([id, viewer]) => {
        const full = viewerPicture(this.page, viewer.capture.viewport);
        const link = viewer.link.rate;
        return {
          id,
          viewport: viewer.capture.viewport,
          codecs: viewer.capture.video?.codecs ?? [],
          link,
          scale: viewer.scale.update(link, full.width * full.height, videoFps, now),
        };
      }),
    );
    if (!plan.encodes.length) {
      if (this.capture) this.close();
      return;
    }
    const size = plan.capture;
    const capture = this.capture;
    if (!capture || capture.width !== size.width || capture.height !== size.height) {
      if (!this.wanted || this.wanted.width !== size.width || this.wanted.height !== size.height)
        this.wanted = { ...size, since: now };
      // The first capture opens at once; a resize waits for the pane to settle.
      if (!capture || now - this.wanted.since >= settleMs) this.open(source, size, now);
    }
    const open = this.capture;
    for (const id of this.viewers.keys())
      this.fanout.assign(id, open ? plan.viewers.get(id) : undefined);
    if (!open) return;
    const encodes = plan.encodes.map((encode) => encode.key).join(",");
    if (encodes !== this.encodes || this.bitratesMoved(plan.encodes, now)) {
      this.encodes = encodes;
      this.bitrates = new Map(plan.encodes.map((encode) => [encode.key, encode.bitrate]));
      this.bitratesAt = now;
      open.handle.encodes(plan.encodes);
    }
    for (const key of this.owedKeys)
      if (encodes.split(",").includes(key)) open.handle.keyframe(key);
    this.owedKeys.clear();
    // The tab's sound is encoded only while someone listens: a muted viewer costs nothing.
    if (this.sound.wanted !== this.soundOn) {
      this.soundOn = this.sound.wanted;
      open.handle.audio?.(this.soundOn);
    }
  }
  /** Whether a running encode's bit rate should change in place now. */
  private bitratesMoved(encodes: readonly VideoEncode[], now: number): boolean {
    if (now - this.bitratesAt < bitrateEveryMs) return false;
    return encodes.some((encode) => {
      const given = this.bitrates.get(encode.key);
      return given === undefined || Math.abs(encode.bitrate - given) > given * bitrateChange;
    });
  }
  private probe(source: LiveVideoSource, now: number): void {
    if (this.opening || now < this.retryAt) return;
    this.opening = true;
    const generation = this.generation;
    void source.host
      .supported(knownCodecs, this.page.width, this.page.height)
      .then(
        (codecs) => {
          this.codecs = codecs;
        },
        () => {
          // No encoder yet (the extension failed to load): it is retried.
          if (generation === this.generation) this.retryAt = this.now() + retryMs;
        },
      )
      .finally(() => {
        this.opening = false;
      });
  }
  private open(source: LiveVideoSource, size: { width: number; height: number }, now: number) {
    if (this.opening || now < this.retryAt) return;
    this.opening = true;
    this.close();
    const generation = this.generation;
    const tabId = this.tabId;
    void source.host
      .open(source.page, size.width, size.height, {
        chunk: (chunk) => {
          if (generation === this.generation) this.publish(chunk, tabId);
        },
        audio: (chunk) => {
          if (generation === this.generation) this.publishSound(chunk, tabId);
        },
        failed: (encode) => {
          const codec = encode.split("/")[0];
          if (codec && generation === this.generation) this.failedCodecs.add(codec);
        },
        ended: () => {
          if (generation !== this.generation) return;
          this.capture = undefined;
          this.encodes = "";
          this.soundOn = false;
          this.fanout.stopAll();
        },
      })
      .then(
        (handle) => {
          if (generation !== this.generation) return handle.close();
          this.capture = { handle, ...size };
          this.encodes = "";
          this.soundOn = false;
        },
        () => {
          if (generation === this.generation) this.retryAt = this.now() + retryMs;
        },
      )
      .finally(() => {
        this.opening = false;
      });
  }
  private close(): void {
    this.generation++;
    this.capture?.handle.close();
    this.capture = undefined;
    this.encodes = "";
    this.soundOn = false;
    this.fanout.stopAll();
  }
  /** Video and sound are stamped when they were captured, so a client can play them in sync. */
  private publish(chunk: EncodedChunk, tabId: string | undefined): void {
    const { encode, age, ...rest } = chunk;
    this.fanout.publish(encode, {
      ...rest,
      sequence: ++this.sequence,
      timestamp: this.now() - (age ?? 0),
      width: this.page.width,
      height: this.page.height,
      ...(tabId ? { tabId } : {}),
    });
  }
  private publishSound(chunk: EncodedAudio, tabId: string | undefined): void {
    if (!this.sound.wanted) return;
    const { age, ...rest } = chunk;
    this.sound.publish({
      ...rest,
      sequence: ++this.soundSequence,
      timestamp: this.now() - age,
      ...(tabId ? { tabId } : {}),
    });
  }
}
