import type { Origin } from "./ingest-sources.ts";
import { MediaRecording, type RecordedPart, type RecordingEnd } from "./recordings.ts";
import type { MediaClock } from "./supervisor-host.ts";
import type { MediaHealth } from "./supervision-policy.ts";
import { MediaTee, type IngestSocket, type TeeUnit } from "./tee.ts";
import { readGapMs, type IssuedEpoch } from "./epochs.ts";
import type { FromMedia, MediaFeature, ToMedia } from "./wire.ts";

type EncodeSpec = Extract<ToMedia, { type: "source.encodes" }>["encodes"][number];
/**
 * How often a picture recording's encode makes a keyframe. Its encoder makes one only when
 * asked, and a part is written a group at a time: this bounds what a crash can lose, and how
 * long a recording waits to resume at a clear keyframe when an earlier ask fell in an epoch it
 * discarded (around a restart, or a private stretch).
 */
export const pictureKeyframeMs = 2_000;
/** How long past the read gap a resumed picture recording asks its encode for a keyframe. */
const resumeMarginMs = 50;
/** The encode id a picture recording's one encode runs under. */
const recordingEncode = 1;
/** Origins whose units are JPEG pictures ace-media encodes. */
const pictureOrigins: ReadonlySet<Origin["kind"]> = new Set(["tab-pictures", "screen-pictures"]);

/**
 * Every recording (docs/media/plan.md, X1): the daemon has a source's units and tees them into
 * ace-media's ingest, where ace-media's recorder writes the parts. Encoded video (a device's
 * H.264, a screen's from egress) goes in as it is; JPEG pictures (a browser tab's screencast, a
 * JPEG-only screen) go in as pictures that ace-media encodes for the recording alone, whether
 * anyone watches or not. There is no other recorder: when ace-media can't take a recording, it
 * refuses to start with the reason, rather than record nothing.
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
  /**
   * The codecs ace-media encodes pictures in here now, best first: empty until its probe found
   * an encoder (the last-resort one reports after `ready`, as `capabilities.changed`).
   */
  pictureCodecs(): readonly string[];
  connect(path: string): IngestSocket;
  /** A source handle never used before in this ace-media process. */
  handle(): number;
  randomBytes(length: number): Uint8Array;
  /** An id unique for the daemon's lifetime. */
  id(): string;
  clock: MediaClock;
};

/** The one encode ace-media runs for a recording of JPEG pictures, whether anyone watches or not. */
export type RecordingEncode = Omit<EncodeSpec, "id">;

export type TeeRecordingSpec = {
  /**
   * What the source is, as ace-media's `source.open` names it. A JPEG kind (`tab-pictures`,
   * `screen-pictures`) takes `picture` units, which ace-media encodes as `encode` says.
   */
  origin: Origin;
  /** For a source of JPEG pictures: the stream ace-media encodes them into and records. */
  encode?: RecordingEncode;
  /** Where ace-media writes the parts (`part-NNNN.mp4`). */
  directory: string;
  /** The most one part holds; ace-media keeps it between 64 KiB and 512 MiB. */
  maxBytes: number;
  /** The source is private now: frames read now are never written. */
  private(): boolean;
  /** Ask the producer for a keyframe (an encoded source's; a picture source needs none). */
  keyframe?(): void;
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
  /** Picture recordings waiting for ace-media's probe to find an encoder. */
  readonly #encoders = new Set<{ done(ok: boolean): void }>();
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
    const pictures = pictureOrigins.has(spec.origin.kind);
    if (pictures !== (spec.encode !== undefined)) {
      release();
      return { ok: false, reason: "A recording of pictures needs its encode, and only it does" };
    }
    // An older ace-media takes pictures only as stills, never encodes them: nothing would be
    // recorded, so it refuses rather than record nothing.
    if (pictures && !port.speaks("picture-ingest")) {
      release();
      return {
        ok: false,
        reason: unavailable("this ace-media is too old to record pictures; update ace"),
      };
    }
    if (pictures && !(await this.#encoder())) {
      release();
      return { ok: false, reason: unavailable("it found no video encoder on this computer") };
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
    if (message.type === "capabilities.changed" && encodesPictures(this.#port))
      for (const waiter of this.#encoders) waiter.done(true);
  }

  /** True once ace-media can encode pictures here, false if it can't within the start's wait. */
  #encoder(): Promise<boolean> {
    if (encodesPictures(this.#port)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = {
        done: (ok: boolean) => {
          if (!this.#encoders.delete(waiter)) return;
          cancel();
          resolve(ok);
        },
      };
      this.#encoders.add(waiter);
      const cancel = this.#port.clock.setTimeout(() => waiter.done(false), recordingStartMs);
    });
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

/** Whether ace-media encodes pictures as H.264 here now: what every picture recording is. */
function encodesPictures(port: Pick<TeeRecordingsPort, "pictureCodecs">): boolean {
  return port.pictureCodecs().some((codec) => codec.startsWith("avc1"));
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
  readonly #source: string;
  readonly #send: (message: ToMedia) => boolean;
  readonly #encodable: () => boolean;
  /** The current open's encode went to ace-media. */
  #encoding = false;
  /**
   * A picture source's epochs issued but not yet stamped: ace-media keeps pictures only of
   * epochs it was told (`source.epoch`), so the tee stamps one only once ace-media applied it.
   */
  #issued: IssuedEpoch[] = [];
  /** `source.epoch`'s sequence in the running ace-media, from 0 after each start. */
  #epochSeq = 0;
  /** ace-media answered the current open: an epoch sent now can't overtake it. */
  #openAnswered = false;
  /** Cancels the keyframe owed once a resume's read gap has passed. */
  #resume: (() => void) | undefined;
  /** Cancels the next regular keyframe. */
  #beat: (() => void) | undefined;

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
    this.#source = source;
    this.#send = (message) => port.send(message);
    this.#encodable = () => encodesPictures(port);
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
        keyframe: () => this.#keyframe(),
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
      issue: (issued) => this.#issue(issued),
      keyframe: () => this.#keyframe(),
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
    if (!this.#open() || !this.#media.start()) return false;
    if (this.#spec.encode) this.#keyframes();
    return true;
  }

  /** A picture recording's regular keyframes, for as long as it runs. */
  #keyframes(): void {
    this.#beat = this.#clock.setTimeout(() => {
      if (this.#done || this.#stopping) return;
      this.#keyframe();
      this.#keyframes();
    }, pictureKeyframeMs);
  }

  /**
   * A new epoch for what the tee reads from now on. An encoded source's tee stamps with it at
   * once and so acknowledges it at once. A picture source's pictures are ace-media's to keep
   * only up to the epochs it was told, so the tee tells it first and stamps with the epoch once
   * ace-media applied it (`epoch.applied`): no picture is ever stamped ahead of what it knows.
   */
  #issue(issued: IssuedEpoch): void {
    if (!this.#spec.encode) {
      this.#media.acknowledged(this.#tee.epoch(issued));
      return;
    }
    this.#issued.push(issued);
    if (this.#openAnswered) this.#announce(issued);
  }

  #announce(issued: IssuedEpoch): void {
    this.#send({
      type: "source.epoch",
      source: this.#source,
      seq: this.#epochSeq++,
      epoch: issued.epoch,
      followsPrivate: issued.followsPrivate,
    });
  }

  /**
   * ace-media applied `epoch`: the tee stamps with it, and every one before it, in order. After
   * a private stretch the recording resumes only at a keyframe of a clear epoch, and the encode
   * makes one only when asked: it is asked once pictures read now are past the read gap.
   */
  #applied(epoch: number): void {
    let resumed = false;
    while (this.#issued[0] && this.#issued[0].epoch <= epoch) {
      const issued = this.#issued.shift();
      if (!issued) break;
      this.#media.acknowledged(this.#tee.epoch(issued));
      resumed ||= issued.followsPrivate;
    }
    if (!resumed || this.#done) return;
    this.#resume?.();
    this.#resume = this.#clock.setTimeout(() => {
      this.#resume = undefined;
      if (!this.#done) this.#keyframe();
    }, readGapMs + resumeMarginMs);
  }

  /** Opens the source in the running ace-media, with a picture source's encode. */
  #open(): boolean {
    this.#encoding = false;
    this.#openAnswered = false;
    this.#epochSeq = 0;
    if (!this.#tee.open()) return false;
    this.#encode();
    return true;
  }

  /**
   * A picture source's own encode, whatever the live views want: it runs while nobody watches.
   * After a restart it waits for the new process's probe to find an encoder again, since an
   * encode asked before then ends the source.
   */
  #encode(): void {
    const encode = this.#spec.encode;
    if (!encode || this.#encoding || !this.#encodable()) return;
    this.#encoding = this.#send({
      type: "source.encodes",
      source: this.#source,
      encodes: [{ ...encode, id: recordingEncode }],
    });
  }

  /** A keyframe is owed: a picture source's encode makes one; any other asks its producer. */
  #keyframe(): void {
    if (this.#spec.encode)
      this.#send({ type: "source.key", source: this.#source, encode: recordingEncode });
    else this.#spec.keyframe?.();
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
    this.#open();
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
    if (message.type === "capabilities.changed") return this.#encode();
    if ("source" in message && message.source === this.#source && this.#spec.encode) {
      if (message.type === "epoch.applied") return this.#applied(message.epoch);
      // ace-media's first word on the open: the epochs waiting for it go now, in order. The
      // open carried the epoch the tee stamps with; every one after it is still owed.
      if (message.type === "source.status" && !this.#openAnswered) {
        this.#openAnswered = true;
        for (const issued of this.#issued) this.#announce(issued);
      }
    }
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
    // Lost during a stop while ace-media still runs: latched now, before an exit could make it
    // look explained and a replay clear it.
    if (this.#stopping && !this.#down) {
      this.#failure = reason;
      return;
    }
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
    this.#resume?.();
    this.#beat?.();
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
