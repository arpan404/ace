import { join } from "node:path";
import type { BrowserFrame, BrowserTabActor } from "@ace/protocol";
import { Recording } from "./recording.ts";
import type { BrowserArtifact } from "@ace/protocol";
import type { BrowserBackendPage } from "./backend.ts";
import type { SessionOptions } from "./session-options.ts";
import { BrowserActionError } from "./action-error.ts";

/** The tab a recording follows, whichever tab the person views meanwhile. */
export interface RecordedTab {
  id: string;
  page: BrowserBackendPage;
  /** The live capture carries this tab's frames now (the person views it). */
  live(): boolean;
  /** Agents may still see the tab: it is open and not kept private. */
  visible(): boolean;
}
/** Frames a tab outside the live capture contributes, about four a second. */
const pollMs = 250;

/**
 * Recording owns disk/process I/O; the session supplies admission fences. A recording follows
 * one tab: while the person views it, the live capture's frames; otherwise screenshots of it.
 */
export class SessionRecording {
  private recording: Recording | undefined;
  private tab: RecordedTab | undefined;
  private stopPolling = () => {};
  private actor: BrowserTabActor | undefined;
  private options: SessionOptions;
  private paused: () => boolean;
  /** Pages hide ace's cursor and mask secret fields before the first frame, and after the last. */
  private masked: (on: boolean) => Promise<void>;
  constructor(
    options: SessionOptions,
    paused: () => boolean,
    masked: (on: boolean) => Promise<void> = async () => {},
  ) {
    this.options = options;
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
  /** A live capture frame; kept only when it shows the recorded tab. */
  accept(frame: BrowserFrame): void {
    const tab = this.tab;
    if (tab && frame.tabId !== undefined && frame.tabId !== tab.id) return;
    this.recording?.accept(frame);
  }
  async close(): Promise<void> {
    if (this.recording) await this.stop();
  }
  async start(
    check: () => void,
    tab: RecordedTab | undefined,
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
  private async begin(
    check: () => void,
    tab: RecordedTab | undefined,
    by: BrowserTabActor,
  ): Promise<void> {
    const recording = await Recording.start(
      join(this.options.dir, this.options.id()),
      this.options.ffmpeg,
      undefined,
      this.options.spawn,
    );
    try {
      check();
      const page = tab?.page ?? this.options.backend;
      const data = await page.screenshot("jpeg");
      check();
      recording.accept({
        sequence: 0,
        timestamp: this.options.now(),
        data: data.toString("base64"),
        ...page.viewport(),
      });
      this.recording = recording;
      this.tab = tab;
      this.actor = by;
      if (tab) this.poll(recording, tab);
    } catch (error) {
      await recording.stop().catch(() => {});
      throw error;
    }
  }
  /** Screenshots of the recorded tab while the live capture shows another one. */
  private poll(recording: Recording, tab: RecordedTab): void {
    const clock = this.options.navigationClock;
    const tick = async () => {
      if (this.recording !== recording) return;
      if (!tab.live() && tab.visible()) {
        const bytes = await tab.page.screenshot("jpeg").catch(() => undefined);
        // The tab may have turned private while its screenshot was taken.
        if (bytes && this.recording === recording && tab.visible() && !tab.live())
          recording.acceptJpeg(this.options.now(), bytes);
      }
      if (this.recording === recording) this.stopPolling = clock.set(pollMs, () => void tick());
    };
    this.stopPolling = clock.set(pollMs, () => void tick());
  }
  async stop(): Promise<BrowserArtifact> {
    const recording = this.recording;
    if (!recording) throw new BrowserActionError("recording_inactive");
    this.recording = undefined;
    this.tab = undefined;
    this.stopPolling();
    await this.masked(false);
    const artifact = await recording.stop().catch(() => {
      throw new BrowserActionError("recording_failed");
    });
    await this.options.artifact(artifact);
    return artifact;
  }
}
