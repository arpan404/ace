import {
  EpochLedger,
  ReadStamper,
  epochIntervalMs,
  type EpochDecision,
  type IssuedEpoch,
} from "./epochs.ts";
import type { MediaClock } from "./supervisor-host.ts";
import type { FromMedia, ToMedia } from "./wire.ts";

/**
 * A recording made by ace-media (docs/media/plan.md, F1): `record.start`, the source's epochs
 * and their decisions, the parts as they close, and `record.stop`. The daemon's state is the
 * truth: after an ace-media restart `replay` starts the recording again, the new process makes
 * the part the crash cut playable and reports it, and the recording continues in a new part.
 */

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
  /** The recording ended: stopped, failed in ace-media, or lost with it while stopping. */
  ended?: (end: RecordingEnd) => void;
  /** A part closed (its size counts toward the caller's own budget). */
  part?: (part: RecordedPart) => void;
  /**
   * The ingest barrier before `record.stop`: resolves true once ace-media has taken every unit
   * the producer read before the stop and decided epoch `decided`, false if it couldn't confirm
   * that in time (bounded by the caller). Without one, the stop goes out at once.
   */
  drain?: (decided: number) => Promise<boolean>;
};

/** How long a `record.stop` that reached ace-media may go unanswered before the stop ends. */
export const stopAckMs = 10_000;

/**
 * How long a stop waits for ace-media to come back after it went away mid-recording: the new
 * process makes the part the crash cut playable, and reports it, before the recording ends.
 */
export const recoveryMs = 30_000;

export type RecordingEnd =
  | {
      ok: true;
      parts: RecordedPart[];
      /**
       * The stop couldn't confirm the last epoch with ace-media (the producer never
       * acknowledged it, or ace-media didn't answer the barrier in time): its frames were left
       * out rather than written undecided.
       */
      truncated?: "final-epoch";
    }
  | { ok: false; reason: string; parts: RecordedPart[] };

export class MediaRecording {
  readonly #options: MediaRecordingOptions;
  readonly #ledger: EpochLedger;
  /** Which epoch a pointer or lease change belongs to, by the same rule a producer stamps by. */
  readonly #stamper: ReadStamper;
  readonly #parts = new Map<number, RecordedPart>();
  #beat: (() => void) | undefined;
  #stopping = false;
  /** `record.stop` reached the running ace-media. */
  #stopSent = false;
  /** Waiting for a new ace-media to recover the recording; cancels that wait. */
  #recovering: (() => void) | undefined;
  /** The deadline of the `record.stop` ace-media has; cancels it. */
  #stopAck: (() => void) | undefined;
  /** The stop's barrier didn't hold: the last epoch was left out. */
  #truncated = false;
  /** The stop's barrier is waiting on the current ace-media. */
  #draining = false;
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
    if (this.#ended) return;
    this.#ledger.restart();
    if (!this.#stopping) {
      this.#sendStart();
      return;
    }
    // Stopped while ace-media was away: the new process recovers the part the crash cut at
    // `record.start` and reports it; nothing new is recorded before the stop.
    if (this.#stopSent) return;
    // A barrier still waiting on this process sends `record.stop` itself once it settles.
    if (this.#sendStart() && !this.#draining) this.#sendStop();
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
      const fresh = !this.#parts.has(part.index);
      this.#parts.set(part.index, part);
      if (fresh) this.#options.part?.(part);
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

  /**
   * Stops, and resolves with the parts once ace-media closed the last one. The epoch the
   * producer is in is decided first (by the same privacy rule as every other) and its frames
   * drained into ace-media, so a clip stopped before the first 100 ms beat still has its video.
   * Stopped while ace-media is away, it waits up to `recoveryMs` for the new process to recover
   * the part the crash cut.
   */
  stop(): Promise<RecordingEnd> {
    if (this.#ended) return Promise.resolve(this.#ended);
    const ended = new Promise<RecordingEnd>((resolve) => {
      if (this.#ended) resolve(this.#ended);
      else this.#waiters.push(resolve);
    });
    if (this.#stopping) return ended;
    this.#stopping = true;
    this.#beat?.();
    // A last epoch: once the producer acknowledges it, every one before it is decided.
    this.#next();
    const decided = this.#ledger.current - 1;
    const drain = this.#options.drain;
    this.#draining = true;
    void (drain ? drain(decided) : Promise.resolve(true))
      .catch(() => false)
      .then((held) => {
        // An exit settled this barrier as lost already; the replay sent the stop.
        if (!this.#draining) return;
        this.#draining = false;
        if (!held) this.#truncated = true;
        if (!this.#ended && !this.#sendStop()) this.#awaitRecovery("media-unavailable");
      });
    return ended;
  }

  /** ace-media went away. A stopping recording waits for the next process to recover it. */
  lost(reason: string): void {
    if (!this.#stopping || this.#ended) return;
    // A barrier the old process never answered can't hold: settled lost before any replay may
    // stop, so the end is marked before the new process's record.done can arrive.
    if (this.#draining) {
      this.#draining = false;
      this.#truncated = true;
    }
    this.#stopSent = false;
    this.#stopAck?.();
    this.#awaitRecovery(reason);
  }

  /** At most one `record.stop` per ace-media process. */
  #sendStop(): boolean {
    if (this.#stopSent) return true;
    this.#stopSent = this.#options.send({
      type: "record.stop",
      recording: this.#options.recording,
    });
    if (this.#stopSent) {
      // A live but unresponsive ace-media must not hold the stop, and the cleanup after it.
      this.#stopAck?.();
      this.#stopAck = this.#options.clock.setTimeout(
        () => this.#end({ ok: false, reason: "stop-unanswered", parts: this.parts }),
        stopAckMs,
      );
    }
    return this.#stopSent;
  }

  #awaitRecovery(reason: string): void {
    if (this.#recovering) return;
    this.#recovering = this.#options.clock.setTimeout(
      () => this.#end({ ok: false, reason, parts: this.parts }),
      recoveryMs,
    );
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

  #end(result: RecordingEnd): void {
    if (this.#ended) return;
    const end: RecordingEnd =
      result.ok && this.#truncated ? { ...result, truncated: "final-epoch" } : result;
    this.#ended = end;
    this.#beat?.();
    this.#recovering?.();
    this.#stopAck?.();
    for (const waiter of this.#waiters.splice(0)) waiter(end);
    this.#options.ended?.(end);
  }
}
