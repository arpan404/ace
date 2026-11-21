import { join } from "node:path";
import type { BrowserArtifact, BrowserFrame, BrowserTabActor } from "@ace/protocol";
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
  ) {
    this.options = options;
    this.recorder = recorder;
    this.paused = paused;
    this.masked = masked;
  }
  get active(): boolean {
    return this.recording !== undefined;
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
    if (this.recording) throw new BrowserActionError("recording_active");
    await this.masked(true);
    try {
      await this.begin(check, tab, by);
    } catch (error) {
      await this.masked(false);
      throw error;
    }
  }
  private async begin(check: () => void, tab: RecordedTab, by: BrowserTabActor): Promise<void> {
    const started = await this.recorder.start({
      origin: { kind: "tab-pictures" },
      encode: recordingEncode(tab.page.viewport()),
      directory: join(this.options.dir, `${this.options.id()}.parts`),
      maxBytes: recordingPartBytes,
      private: () => tab.privacy().private === true,
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
    const recording: Running = { media: started.recording, tab };
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
  /** Stops, and publishes every part ace-media wrote; the first stands for the recording. */
  async stop(): Promise<BrowserArtifact> {
    const recording = this.recording;
    if (!recording) throw new BrowserActionError("recording_inactive");
    this.recording = undefined;
    this.stopPolling();
    await this.masked(false);
    const end = await recording.media.stop();
    const artifacts: BrowserArtifact[] = end.parts.map((part) => ({
      path: part.path,
      mimeType: "video/mp4",
      bytes: part.bytes,
    }));
    const [first] = artifacts;
    if (!first)
      throw end.ok
        ? new BrowserActionError("recording_failed")
        : new PublicToolError("recording_failed", undefined, undefined, undefined, end.reason);
    for (const artifact of artifacts) await this.options.artifact(artifact);
    return first;
  }
}
