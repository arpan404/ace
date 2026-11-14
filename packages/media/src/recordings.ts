import {
  EpochLedger,
  ReadStamper,
  epochIntervalMs,
  type EpochDecision,
  type IssuedEpoch,
} from "./epochs.ts";
import type { MediaClock } from "./supervisor-host.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/**
 * A recording made by ace-media (docs/media/plan.md, F1): `record.start`, the source's epochs
 * and their decisions, the parts as they close, and `record.stop`. The daemon's state is the
 * truth: after an ace-media restart `replay` starts the recording again, the new process makes
 * the part the crash cut playable and reports it, and the recording continues in a new part.
 */

export type RecordingRoute = "ace-media" | "legacy";

/**
 * Where a new recording goes. `media.recordings` is `legacy` by default; `auto` uses ace-media
 * only while it is healthy, so a recording never waits on a process that isn't there.
 */
export function recordingRoute(settings: MediaSettings, health: MediaHealth): RecordingRoute {
  return settings.recordings === "auto" && health === "healthy" ? "ace-media" : "legacy";
}

export type RecordedPart = Extract<FromMedia, { type: "record.done" }>["parts"][number];

export type MediaRecordingOptions = {
  recording: string;
  source: string;
  directory: string;
  /** The most one part holds; ace-media caps it at 512 MiB. */
  maxBytes: number;
  pointerTrack: boolean;
  send: (message: ToMedia) => boolean;
  clock: MediaClock;
  /** The source is private now (a private tab, a paused share). */
  private: () => boolean;
  /** The source's epoch when the recording starts. */
  epoch: number;
  /** Hands the producer a new epoch. It calls `acknowledged` once it stamps with it. */
  issue: (epoch: IssuedEpoch) => void;
  /** A producer silent past the deadline must start over at a keyframe. */
  keyframe: () => void;
};

export type RecordingEnd =
  | { ok: true; parts: RecordedPart[] }
  | { ok: false; reason: string; parts: RecordedPart[] };

export class MediaRecording {
  readonly #options: MediaRecordingOptions;
  readonly #ledger: EpochLedger;
  /** Which epoch a pointer or lease change belongs to, by the same rule a producer stamps by. */
  readonly #stamper: ReadStamper;
  readonly #parts = new Map<number, RecordedPart>();
  #beat: (() => void) | undefined;
  #stopping = false;
  #ended: RecordingEnd | undefined;
  #waiters: ((end: RecordingEnd) => void)[] = [];

  constructor(options: MediaRecordingOptions) {
    this.#options = options;
    this.#ledger = new EpochLedger({
      epoch: options.epoch,
      private: options.private(),
      now: options.clock.now(),
    });
    this.#stamper = new ReadStamper(options.epoch);
  }

  /** The epoch the source is in now, for reopening it in a new ace-media process. */
  get epoch(): number {
    return this.#ledger.current;
  }

  /** Every part so far, in order, across ace-media restarts. */
  get parts(): RecordedPart[] {
    return [...this.#parts.values()].toSorted((a, b) => a.index - b.index);
  }

  /** Sends `record.start` and begins the 100 ms epochs. False when ace-media can't take it. */
  start(): boolean {
    if (!this.#sendStart()) return false;
    this.#schedule();
    return true;
  }

  /** ace-media started again and the source was reopened: record into a new part. */
  replay(): void {
    if (this.#ended || this.#stopping) return;
    this.#ledger.restart();
    this.#sendStart();
  }

  /** A privacy transition: a new epoch at once, so no epoch spans it. */
  privacy(): void {
    if (this.#ended) return;
    this.#next();
  }

  /** The producer applied `epoch`. */
  acknowledged(epoch: number): void {
    if (this.#ended) return;
    this.#decision(this.#ledger.acknowledged(epoch, this.#options.clock.now()));
  }

  /** A message from ace-media; those about other recordings are ignored. */
  message(message: FromMedia): void {
    if (!("recording" in message) || message.recording !== this.#options.recording) return;
    if (message.type === "record.part") {
      const { type: _, recording: __, ...part } = message;
      this.#parts.set(part.index, part);
    } else if (message.type === "record.done") {
      for (const part of message.parts) this.#parts.set(part.index, part);
      this.#end({ ok: true, parts: this.parts });
    } else if (message.type === "record.failed") {
      this.#end({ ok: false, reason: message.reason, parts: this.parts });
    }
  }

  /**
   * `record.meta` for the pointer track. It is stamped as a read-time producer stamps a frame:
   * within 100 ms of an epoch that follows a private one it still gets the private epoch, so a
   * change from the private moment that reaches the daemon just after the resume is dropped.
   */
  meta(data: unknown): void {
    if (this.#ended || !this.#options.pointerTrack) return;
    this.#options.send({
      type: "record.meta",
      recording: this.#options.recording,
      epoch: this.#stamper.stamp(this.#options.clock.now()),
      data,
    });
  }

  /** Stops, and resolves with the parts once ace-media closed the last one. */
  stop(): Promise<RecordingEnd> {
    if (this.#ended) return Promise.resolve(this.#ended);
    this.#stopping = true;
    this.#beat?.();
    if (!this.#options.send({ type: "record.stop", recording: this.#options.recording })) {
      this.#end({ ok: false, reason: "media-unavailable", parts: this.parts });
    }
    return new Promise((resolve) => {
      if (this.#ended) resolve(this.#ended);
      else this.#waiters.push(resolve);
    });
  }

  /** ace-media went away while stopping: what was reported is what there is. */
  lost(reason: string): void {
    if (this.#stopping) this.#end({ ok: false, reason, parts: this.parts });
  }

  #sendStart(): boolean {
    const { recording, source, directory, maxBytes, pointerTrack, send } = this.#options;
    return send({ type: "record.start", recording, source, directory, maxBytes, pointerTrack });
  }

  #schedule(): void {
    this.#beat = this.#options.clock.setTimeout(() => {
      if (this.#ended || this.#stopping) return;
      this.#next();
      this.#schedule();
    }, epochIntervalMs);
  }

  #next(): void {
    const now = this.#options.clock.now();
    const expired = this.#ledger.expire(now);
    if (expired) {
      this.#decision(expired);
      this.#options.keyframe();
    }
    const issued = this.#ledger.issue(now, this.#options.private());
    this.#stamper.apply(issued.epoch, issued.followsPrivate, now);
    this.#options.issue(issued);
  }

  #decision(decision: EpochDecision | undefined): void {
    if (!decision) return;
    const { source, recording } = this.#options;
    this.#options.send({ type: "record.epochs", source, recording, ...decision });
  }

  #end(end: RecordingEnd): void {
    if (this.#ended) return;
    this.#ended = end;
    this.#beat?.();
    for (const waiter of this.#waiters.splice(0)) waiter(end);
  }
}
