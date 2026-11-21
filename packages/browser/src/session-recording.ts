import { join } from "node:path";
import type { BrowserArtifact, BrowserFrame, BrowserTabActor } from "@ace/protocol";
import type { RecordingEnd } from "@ace/media/recordings";
import type { ActiveRecording, MediaRecorder, RecordingEncode } from "@ace/media/tee-recordings";
import { PublicToolError } from "@ace/mcp-server/errors";
import type { BrowserBackendPage } from "./backend.ts";
import type { SessionOptions } from "./session-options.ts";
import { BrowserActionError } from "./action-error.ts";
import { frameBytes } from "./frame-bytes.ts";
import { imageSize } from "./image-size.ts";
import { capturedEpoch, type Privacy } from "./live.ts";

/** The tab a recording follows, whichever tab the person views meanwhile. */
export interface RecordedTab {
  /** Undefined on a backend without tabs: the one page it shows. */
  id: string | undefined;
  page: BrowserBackendPage;
  /** The live capture carries this tab's frames now (the person views it). */
  live(): boolean;
  /** Agents may still see the tab: it is open and not kept private. */
  visible(): boolean;
  /** The tab's own privacy now: every picture of it is fenced on it. */
  privacy(): Privacy;
}

/** Frames a tab outside the live capture contributes, about four a second. */
const pollMs = 250;
/** The most a recording holds in one part; a normal recording is one part. */
const recordingPartBytes = 256 * 1024 * 1024;
/** The recording's picture: the page fitted inside this, as the screencast is. */
const maxWidth = 1280;
const maxHeight = 960;

/** The one encode a recording runs in ace-media: the page's shape, fitted, at the screencast's rate. */
export function recordingEncode(viewport: { width: number; height: number }): RecordingEncode {
  const fit = Math.min(1, maxWidth / viewport.width, maxHeight / viewport.height);
  const even = (value: number) => Math.max(64, 2 * Math.floor((value * fit) / 2));
  return {
    codec: "avc1.42E033",
    width: even(viewport.width),
    height: even(viewport.height),
    fps: 15,
    bitrate: 2_500_000,
  };
}

/**
 * Whether a picture of `tab` captured at `capturedAt` (the session's clock) may be recorded: the
 * same capture-time fence the live video keeps. Never while the tab is private; never a picture
 * captured at or before its last privacy change; and none from the read gap after it stopped
 * being private, when the page may still show what it hid.
 */
export function recordable(tab: RecordedTab, capturedAt: number): boolean {
  const privacy = tab.privacy();
  if (privacy.private === true || capturedAt <= privacy.since) return false;
  return capturedEpoch(privacy, capturedAt) === privacy.epoch;
}

type Running = { media: ActiveRecording; tab: RecordedTab };

/**
 * A browser recording (X1): ace-media records it, from the JPEG pictures the session takes of
 * the recorded tab (the live capture's while the person views it, screenshots otherwise), which
 * it encodes for the recording alone, whether anyone watches or not. Every picture passes the
 * tab's capture-time privacy fence before it goes. The session supplies admission fences.
 */
export class SessionRecording {
  private recording: Running | undefined;
  /** A start is under way: the recording slot is its. */
  private reserved = false;
  /** A recording ace-media ended on its own (its capture is gone): kept for the stop. */
  private completed: RecordingEnd | undefined;
  private noticed: string | undefined;
  /** Bumped by every start: a notice belongs to the recording it is written for, no later one. */
  private generation = 0;
  private changed: () => void;
  private stopPolling = () => {};
  private actor: BrowserTabActor | undefined;
  private options: SessionOptions;
  private recorder: MediaRecorder;
  private paused: () => boolean;
  /** Pages hide ace's cursor and mask secret fields before the first frame, and after the last. */
  private masked: (on: boolean) => Promise<void>;
  constructor(
    options: SessionOptions,
    recorder: MediaRecorder,
    paused: () => boolean,
    masked: (on: boolean) => Promise<void> = async () => {},
    /** The recording's state changed on its own (ace-media ended it): the session tells clients. */
    changed: () => void = () => {},
  ) {
    this.options = options;
    this.recorder = recorder;
    this.paused = paused;
    this.masked = masked;
    this.changed = changed;
  }
  /** What the person should know about the last recording, until the next one starts. */
  get notice(): string | undefined {
    return this.noticed;
  }
  /** A recording runs, or one is starting (its slot is taken until it runs or is cleaned up). */
  get active(): boolean {
    return this.recording !== undefined || this.reserved;
  }
  /** Who started the recording that runs now; people see it and can stop it. */
  get by(): BrowserTabActor | undefined {
    return this.recording ? this.actor : undefined;
  }
  /**
   * A live capture frame captured at `capturedAt`: recorded only when it shows the recorded tab
   * and passes that tab's fence.
   */
  accept(frame: BrowserFrame, capturedAt: number): void {
    const recording = this.recording;
    if (!recording || frame.tabId !== recording.tab.id) return;
    this.push(recording, frameBytes(frame), capturedAt);
  }
  /** A tab's privacy changed: a new epoch at once, so none spans the change. */
  privacyChanged(): void {
    this.recording?.media.privacy();
  }
  /** The browser closes: what was recorded is saved if it can be; closing never waits on why not. */
  async close(): Promise<void> {
    if (this.recording) await this.stop().catch(() => {});
  }
  async start(
    check: () => void,
    tab: RecordedTab,
    by: BrowserTabActor = { kind: "agent" },
  ): Promise<void> {
    check();
    if (this.paused()) throw new BrowserActionError("browser_paused");
    // The one slot is taken before anything awaits, and held until the recording runs or what
    // a failed start opened is stopped: a second start meanwhile, from any tab, is refused.
    if (this.recording || this.reserved) throw new BrowserActionError("recording_active");
    this.reserved = true;
    try {
      await this.masked(true);
      try {
        await this.begin(check, tab, by);
      } catch (error) {
        await this.masked(false);
        throw error;
      }
    } finally {
      this.reserved = false;
    }
  }
  private async begin(check: () => void, tab: RecordedTab, by: BrowserTabActor): Promise<void> {
    this.completed = undefined;
    this.noticed = undefined;
    const generation = ++this.generation;
    let recording: Running | undefined;
    const started = await this.recorder.start({
      origin: { kind: "tab-pictures" },
      encode: recordingEncode(tab.page.viewport()),
      directory: join(this.options.dir, `${this.options.id()}.parts`),
      maxBytes: recordingPartBytes,
      private: () => tab.privacy().private === true,
      // ace-media ended it (an ingest it lost for good, a write it couldn't make): the browser
      // stops saying it records, and the stop publishes what was written and says why.
      failed: (end) => {
        if (!recording || this.recording !== recording) return;
        this.recording = undefined;
        this.stopPolling();
        this.completed = end;
        if (generation === this.generation)
          this.noticed =
            "Recording stopped because it couldn't be written. What was recorded is saved when it is stopped.";
        void this.masked(false).catch(() => {});
        this.changed();
      },
    });
    // ace-media can't record now: the recording refuses, saying why, rather than record nothing.
    if (!started.ok)
      throw new PublicToolError(
        "recording_failed",
        undefined,
        undefined,
        undefined,
        started.reason,
      );
    recording = { media: started.recording, tab };
    try {
      check();
      // The first picture, as a static page may draw no screencast frame. Its capture time is
      // when it was asked for, and it is fenced like any other.
      const capturedAt = this.options.now();
      const data = await tab.page.screenshot("jpeg");
      check();
      this.recording = recording;
      this.actor = by;
      this.push(recording, data, capturedAt);
      if (tab.id !== undefined) this.poll(recording);
    } catch (error) {
      this.recording = undefined;
      await recording.media.stop().catch(() => {});
      throw error;
    }
  }
  /** One picture of the recorded tab, captured at `capturedAt`, if its fence lets it through. */
  private push(recording: Running, jpeg: Uint8Array, capturedAt: number): void {
    if (this.recording !== recording || !recordable(recording.tab, capturedAt)) return;
    const size = imageSize(jpeg);
    if (!size) return;
    recording.media.push({ kind: "picture", keyframe: true, codec: 7, ...size, payload: jpeg });
  }
  /** Screenshots of the recorded tab while the live capture shows another one. */
  private poll(recording: Running): void {
    const clock = this.options.navigationClock;
    const { tab } = recording;
    const tick = async () => {
      if (this.recording !== recording) return;
      if (!tab.live() && tab.visible()) {
        // The screenshot may show the page as it was when it was asked for: that is its capture
        // time for the fence, so a privacy change while it is taken keeps it out.
        const capturedAt = this.options.now();
        const bytes = await tab.page.screenshot("jpeg").catch(() => undefined);
        if (bytes && !tab.live() && tab.visible()) this.push(recording, bytes, capturedAt);
      }
      if (this.recording === recording) this.stopPolling = clock.set(pollMs, () => void tick());
    };
    this.stopPolling = clock.set(pollMs, () => void tick());
  }
  /**
   * Stops, and publishes every part ace-media wrote; the first stands for the recording. A
   * recording ace-media failed publishes what it wrote and still fails, saying why; one whose
   * last moment ace-media couldn't confirm is returned with a notice that its end may be
   * incomplete.
   */
  async stop(): Promise<BrowserArtifact> {
    const recording = this.recording;
    const completed = this.completed;
    if (!recording && !completed) throw new BrowserActionError("recording_inactive");
    // The slot is free from here on, and a new recording may start while this one finishes:
    // what this stop says is written only while no newer one has.
    const generation = this.generation;
    const notice = (text: string | undefined) => {
      if (generation !== this.generation) return;
      this.noticed = text;
      this.changed();
    };
    this.recording = undefined;
    this.completed = undefined;
    let end: RecordingEnd | undefined = completed;
    if (recording) {
      this.stopPolling();
      await this.masked(false);
      end = await recording.media.stop();
    }
    if (!end) throw new BrowserActionError("recording_inactive");
    const artifacts: BrowserArtifact[] = end.parts.map((part) => ({
      path: part.path,
      mimeType: "video/mp4",
      bytes: part.bytes,
    }));
    for (const artifact of artifacts) await this.options.artifact(artifact);
    if (!end.ok) {
      notice(
        artifacts.length
          ? "The recording failed; what was recorded before the failure is saved to this thread."
          : undefined,
      );
      throw new PublicToolError("recording_failed", undefined, undefined, undefined, end.reason);
    }
    const [first] = artifacts;
    if (!first) throw new BrowserActionError("recording_failed");
    if (end.truncated)
      notice(
        "The recording is saved, but ace-media couldn't confirm its last moment: the end may be incomplete.",
      );
    return first;
  }
}
