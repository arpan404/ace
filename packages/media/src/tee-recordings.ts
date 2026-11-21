import type { Origin } from "./ingest-sources.ts";
import { MediaRecording, type RecordedPart, type RecordingEnd } from "./recordings.ts";
import type { MediaClock } from "./supervisor-host.ts";
import type { MediaHealth } from "./supervision-policy.ts";
import { MediaTee, type IngestSocket, type TeeUnit } from "./tee.ts";
import type { FromMedia, MediaFeature, ToMedia } from "./wire.ts";

/**
 * Recordings until X2 (docs/media/plan.md, phase 1): the daemon has a source's frames (from its
 * own producer socket, or back from ace-media on egress) and tees them into ace-media's ingest,
 * where ace-media's recorder writes the parts. There is no other recorder: when ace-media can't
 * take a recording, it refuses to start with the reason, rather than record nothing.
 *
 * The daemon's state is the truth. After an ace-media restart `replay` reopens every recording's
 * source and starts it again; the new process makes the part the crash cut playable, and the
 * recording continues in a new part.
 */

export type TeeRecordingsPort = {
  /** False when ace-media can't take the message now. */
  send(message: ToMedia, payload?: Uint8Array): boolean;
  /** ace-media's ingest socket path now; it changes with every start. */
  ingest(): string | undefined;
  /** Marks a use of ace-media and starts it; returns the release. */
  need(): () => void;
  health(): MediaHealth;
  /** Why ace-media isn't available, when it isn't. */
  reason(): string | undefined;
  /** Whether the running ace-media agreed to an optional feature (`ready.features`). */
  speaks(feature: MediaFeature): boolean;
  connect(path: string): IngestSocket;
  /** A source handle never used before in this ace-media process. */
  handle(): number;
  randomBytes(length: number): Uint8Array;
  /** An id unique for the daemon's lifetime. */
  id(): string;
  clock: MediaClock;
};

export type TeeRecordingSpec = {
  /** What the source is, as ace-media's `source.open` names it. */
  origin: Origin;
  /** Where ace-media writes the parts (`part-NNNN.mp4`). */
  directory: string;
  /** The most one part holds; ace-media keeps it between 64 KiB and 512 MiB. */
  maxBytes: number;
  /** The source is private now: frames read now are never written. */
  private(): boolean;
  /** Ask the producer for a keyframe. */
  keyframe(): void;
  /** The recording ended without `stop` (ace-media failed it). */
  failed?(end: RecordingEnd): void;
  /** A part closed: ace-media reported it, once. */
  part?(part: RecordedPart): void;
};

/** A recording as its producer drives it. */
export type ActiveRecording = {
  /** One unit of the source, read now. */
  push(unit: TeeUnit): void;
  /** The source turned private or public. */
  privacy(): void;
  /** Stops, and resolves with the parts once ace-media closed the last one. */
  stop(): Promise<RecordingEnd>;
  /** Every part ace-media reported so far, across its restarts. */
  readonly parts: RecordedPart[];
};

export type RecordingStart =
  | { ok: true; recording: ActiveRecording }
  | { ok: false; reason: string };

/** How long a recording waits for ace-media to start before it refuses. */
export const recordingStartMs = 10_000;

type Waiter = { done(reason?: string): void };

export class TeeRecordings {
  readonly #port: TeeRecordingsPort;
  readonly #live = new Set<TeeRecording>();
  readonly #waiters = new Set<Waiter>();
  /** ace-media is running with both lanes, and has been replayed. */
  #up = false;

  constructor(port: TeeRecordingsPort) {
    this.#port = port;
  }

  /** Recordings running now. */
  get active(): number {
    return this.#live.size;
  }

  /**
   * Starts a recording once ace-media runs. Refuses, with the reason, when ace-media is
   * unavailable, doesn't start within `recordingStartMs`, or won't take the recording.
   */
  async start(spec: TeeRecordingSpec): Promise<RecordingStart> {
    const port = this.#port;
    const release = port.need();
    const refused = await this.#ready();
    if (refused) {
      release();
      return { ok: false, reason: refused };
    }
    const recording = new TeeRecording(port, spec, release, (it) => this.#live.delete(it));
    if (!recording.begin()) {
      recording.abandon();
      return { ok: false, reason: unavailable(port.reason() ?? "it didn't take the recording") };
    }
    const accepted = recording.accepted();
    this.#live.add(recording);
    // Started only once ace-media took the ingest connection: frames go somewhere from now on.
    if (!(await deadline(accepted, port.clock, recordingStartMs))) {
      recording.abandon();
      return { ok: false, reason: unavailable("it didn't accept the recording's video") };
    }
    return { ok: true, recording };
  }

  /** ace-media is up again (or for the first time): every recording continues in a new part. */
  replay(): void {
    this.#up = true;
    for (const recording of this.#live) recording.replay();
    for (const waiter of this.#waiters) waiter.done();
  }

  message(message: FromMedia): void {
    for (const recording of this.#live) recording.message(message);
  }

  /** ace-media exited. A restart replays; a recording stopping meanwhile ends with what it has. */
  exited(): void {
    this.#up = false;
    for (const recording of this.#live) recording.exited();
    if (this.#port.health() === "unavailable")
      for (const waiter of this.#waiters)
        waiter.done(unavailable(this.#port.reason() ?? "it keeps failing"));
  }

  /** Undefined once ace-media is up; otherwise why the recording can't start. */
  #ready(): Promise<string | undefined> {
    if (this.#up) return Promise.resolve(undefined);
    const port = this.#port;
    if (port.health() === "unavailable")
      return Promise.resolve(unavailable(port.reason() ?? "it keeps failing"));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        done: (reason) => {
          if (!this.#waiters.delete(waiter)) return;
          cancel();
          resolve(reason);
        },
      };
      this.#waiters.add(waiter);
      const cancel = port.clock.setTimeout(
        () => waiter.done(unavailable("it didn't start in time")),
        recordingStartMs,
      );
    });
  }
}

/** `work`'s result, or false once `ms` pass first. */
function deadline(work: Promise<boolean>, clock: MediaClock, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = clock.setTimeout(() => resolve(false), ms);
    void work.then((ok) => {
      cancel();
      resolve(ok);
    });
  });
}

/**
 * How long a lost ingest connection may wait for a replacement ace-media accepts before it
 * fails the recording. A loss ace-media's exit explains may wait `restartLossGraceMs` from the
 * loss instead, for the restart's replay; past either, the recording fails.
 */
export const ingestLossGraceMs = 1_000;
export const restartLossGraceMs = 5_000;
/** How long the stop's ingest barrier may go unanswered before the last epoch is left out. */
export const syncMs = 2_000;

function unavailable(why: string): string {
  return `ace-media isn't available to record: ${why}`;
}

/** One recording: a tee into ace-media's ingest and the recording ace-media makes of it. */
export class TeeRecording implements ActiveRecording {
  readonly #tee: MediaTee;
  readonly #media: MediaRecording;
  readonly #release: () => void;
  readonly #forget: (recording: TeeRecording) => void;
  #stopping = false;
  #done = false;
  /** A lost ingest connection with no accepted replacement yet. */
  #loss: { reason: string; at: number; cancel: () => void; restarting: boolean } | undefined;
  /** A loss nothing replaced in time: the recording failed, however it ends. */
  #failure: string | undefined;
  readonly #clock: MediaClock;
  readonly #spec: TeeRecordingSpec;
  /** ace-media exited and hasn't been replayed yet. */
  #down = false;

  constructor(
    port: TeeRecordingsPort,
    spec: TeeRecordingSpec,
    release: () => void,
    forget: (recording: TeeRecording) => void,
  ) {
    this.#release = release;
    this.#forget = forget;
    this.#clock = port.clock;
    this.#spec = spec;
    const id = port.id();
    const source = `recording:${id}`;
    this.#tee = new MediaTee(
      {
        source,
        handle: () => port.handle(),
        origin: spec.origin,
        send: (message, payload) => port.send(message, payload),
        ingest: () => port.ingest(),
        connect: (path) => port.connect(path),
        now: () => port.clock.now(),
        randomBytes: (length) => port.randomBytes(length),
        keyframe: () => spec.keyframe(),
        lost: (reason) => this.#lost(reason),
        speaks: (feature) => port.speaks(feature),
      },
      1,
    );
    this.#media = new MediaRecording({
      recording: id,
      source,
      directory: spec.directory,
      maxBytes: spec.maxBytes,
      pointerTrack: false,
      send: (message) => port.send(message),
      clock: port.clock,
      private: () => spec.private(),
      epoch: 1,
      // The tee stamps with an epoch from the moment it has it, so it acknowledges at once.
      issue: (issued) => this.#media.acknowledged(this.#tee.epoch(issued)),
      keyframe: () => spec.keyframe(),
      part: (part) => spec.part?.(part),
      // ace-media answers once it took every frame written and decided the last epoch.
      drain: (decided) => deadline(this.#tee.sync(decided), port.clock, syncMs),
      ended: (end) => {
        const stopping = this.#stopping;
        this.#finish();
        if (!stopping) spec.failed?.(end);
      },
    });
  }

  /** @internal Resolves once ace-media took the next ingest connection, false if it didn't. */
  accepted(): Promise<boolean> {
    return this.#tee.accepted();
  }

  /** @internal Opens the source and starts the recording; false when ace-media refused. */
  begin(): boolean {
    return this.#tee.open() && this.#media.start();
  }

  /** @internal A recording that never got going: whatever ace-media began is stopped. */
  abandon(): void {
    this.#stopping = true;
    void this.#media.stop();
    this.#finish();
  }

  /**
   * @internal ace-media is up again. A running recording continues in a new part; a stopping
   * one reopens its source only so the new process can recover the part the crash cut.
   */
  replay(): void {
    if (this.#done) return;
    this.#down = false;
    this.#tee.open();
    // A stopping recording takes no more video: the new process recovering the part the crash
    // cut is all that's left, so the crash's own loss needs no replacement (the end still says
    // its last epoch was left out). A running one needs ace-media to accept the new connection.
    if (this.#stopping && this.#loss?.restarting) this.#replaced();
    else
      void this.#tee.accepted().then((ok) => {
        if (ok) this.#replaced();
      });
    this.#media.replay();
  }

  /** @internal */
  message(message: FromMedia): void {
    this.#tee.message(message);
    this.#media.message(message);
  }

  /** @internal */
  exited(): void {
    this.#down = true;
    const loss = this.#loss;
    // A crash explains a loss for as long as the restart may take, never longer.
    if (loss && !loss.restarting) {
      loss.cancel();
      loss.restarting = true;
      loss.cancel = this.#clock.setTimeout(
        () => this.#unreplaced(),
        Math.max(0, loss.at + restartLossGraceMs - this.#clock.now()),
      );
    }
    this.#media.lost("media-exited");
  }

  /** The ingest connection went away: unless ace-media accepts a replacement in time, it fails. */
  #lost(reason: string): void {
    if (this.#done || this.#loss || this.#failure) return;
    // Lost while ace-media is already down: the restart may replace it.
    const restarting = this.#down;
    this.#loss = {
      reason,
      at: this.#clock.now(),
      restarting,
      cancel: this.#clock.setTimeout(
        () => this.#unreplaced(),
        restarting ? restartLossGraceMs : ingestLossGraceMs,
      ),
    };
  }

  /** ace-media accepted a new ingest connection: a pending loss is over. */
  #replaced(): void {
    this.#loss?.cancel();
    this.#loss = undefined;
  }

  #unreplaced(): void {
    const loss = this.#loss;
    if (!loss || this.#done) return;
    this.#loss = undefined;
    this.#failure = loss.reason;
    if (this.#stopping) return; // The stop under way reports the failure.
    this.#stopping = true;
    // The video read from here on reaches nobody: end with what ace-media wrote, and say so.
    void this.#media.stop().then((end) => this.#spec.failed?.(this.#failed(end)));
  }

  /** `end`, as a failure when the ingest connection was lost and never replaced. */
  #failed(end: RecordingEnd): RecordingEnd {
    const reason = this.#failure ?? this.#loss?.reason;
    return reason === undefined ? end : { ok: false, reason, parts: end.parts };
  }

  get parts(): RecordedPart[] {
    return this.#media.parts;
  }

  /** One unit of the source, read now. */
  push(unit: TeeUnit): void {
    if (!this.#done && !this.#stopping) this.#tee.push(unit);
  }

  /** The source turned private or public: a new epoch at once, so none spans the change. */
  privacy(): void {
    this.#media.privacy();
  }

  /**
   * Stops, and resolves with the parts once ace-media closed the last one. A loss nothing
   * replaced makes it a failure, even when the stop itself went through.
   */
  stop(): Promise<RecordingEnd> {
    // A loss no exit explains when the stop begins is latched: no later restart or recovery
    // turns it back into a clean recording.
    if (this.#loss && !this.#loss.restarting) this.#failure ??= this.#loss.reason;
    this.#stopping = true;
    return this.#media.stop().then((end) => this.#failed(end));
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#loss?.cancel();
    this.#tee.close();
    this.#forget(this);
    this.#release();
  }
}

/** What a recorder (a screen, device or browser session) records through. */
export type MediaRecorder = { start(spec: TeeRecordingSpec): Promise<RecordingStart> };

/** A recorder for a daemon without ace-media: every recording refuses, saying why. */
export function refusingRecorder(why: string): MediaRecorder {
  return { start: () => Promise.resolve({ ok: false, reason: unavailable(why) }) };
}
