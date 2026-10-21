import { MediaClock } from "../src/media-clock.ts";

/*
 * The sound of one tab capture, encoded as Opus while the daemon wants it (ADR 0088, Audio).
 * The capture's audio track stays open for the capture's life; a clone of it is read and
 * encoded only while someone listens, so a capture nobody hears costs no encoding.
 */

interface SampleReader {
  read(): Promise<{ done: boolean; value?: AudioData }>;
  cancel(): Promise<void>;
}
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
  readonly readable: { getReader(): SampleReader };
};

/** Speech and music both sound clean at this rate; a silent page sends almost nothing (DTX). */
const bitrate = 96_000;
/**
 * Opus runs at 48 kHz (RFC 6716): Chrome's encoder resamples other capture rates to it, such as
 * the 44.1 kHz a Linux tab capture delivers. Viewers decode at this rate; a decoder configured
 * with the capture's 44.1 kHz fails on the stream.
 */
const opusSampleRate = 48_000;

interface Running {
  track: MediaStreamTrack;
  reader: SampleReader;
  encoder: AudioEncoder | undefined;
  format: { sampleRate: number; channels: number } | undefined;
  clock: MediaClock;
}

export class TabAudio {
  private source: MediaStreamTrack;
  private emit: (event: Record<string, unknown>, bytes: Uint8Array) => void;
  private now: () => number;
  private running: Running | undefined;
  constructor(
    source: MediaStreamTrack,
    emit: (event: Record<string, unknown>, bytes: Uint8Array) => void,
    now: () => number,
  ) {
    this.source = source;
    this.emit = emit;
    this.now = now;
  }
  set(on: boolean): void {
    if (on && !this.running) this.start();
    if (!on) this.pause();
  }
  /** The capture ended: its sound with it. */
  stop(): void {
    this.pause();
    this.source.stop();
  }
  private start(): void {
    const track = this.source.clone();
    const running: Running = {
      track,
      reader: new MediaStreamTrackProcessor({ track }).readable.getReader(),
      encoder: undefined,
      format: undefined,
      clock: new MediaClock(),
    };
    this.running = running;
    void this.pump(running).catch(() => {
      if (this.running === running) this.pause();
    });
  }
  private pause(): void {
    const running = this.running;
    if (!running) return;
    this.running = undefined;
    if (running.encoder && running.encoder.state !== "closed") running.encoder.close();
    void running.reader.cancel().catch(() => {});
    running.track.stop();
  }
  private async pump(running: Running): Promise<void> {
    for (;;) {
      const { done, value } = await running.reader.read();
      if (done || !value) return;
      try {
        if (this.running !== running) return;
        running.clock.arrived(value.timestamp, this.now());
        const encoder = this.encoderFor(running, value);
        if (encoder.state === "configured") encoder.encode(value);
      } finally {
        value.close();
      }
    }
  }
  /** The encoder for these samples' format: a new one when the format changed. */
  private encoderFor(running: Running, data: AudioData): AudioEncoder {
    const format = { sampleRate: data.sampleRate, channels: data.numberOfChannels };
    if (
      running.encoder &&
      running.format?.sampleRate === format.sampleRate &&
      running.format.channels === format.channels
    )
      return running.encoder;
    if (running.encoder && running.encoder.state !== "closed") running.encoder.close();
    const encoder = new AudioEncoder({
      output: (chunk) => {
        if (this.running !== running || running.encoder !== encoder) return;
        const captured = running.clock.map(chunk.timestamp);
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.emit(
          {
            t: "audio",
            codec: "opus",
            sampleRate: opusSampleRate,
            channels: format.channels,
            age: captured === undefined ? 0 : Math.max(0, this.now() - captured),
          },
          bytes,
        );
      },
      error: () => {
        if (this.running === running) this.pause();
      },
    });
    encoder.configure({
      codec: "opus",
      sampleRate: format.sampleRate,
      numberOfChannels: format.channels,
      bitrate,
      opus: { usedtx: true },
    });
    running.encoder = encoder;
    running.format = format;
    return encoder;
  }
}
