import { join } from "node:path";
import type { BrowserFrame, BrowserTabActor } from "@ace/protocol";
import { Recording } from "./recording.ts";
import type { BrowserArtifact } from "@ace/protocol";
import type { SessionOptions } from "./session-options.ts";

/** Recording owns disk/process I/O; the session supplies admission fences. */
export class SessionRecording {
  private recording: Recording | undefined;
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
  accept(frame: BrowserFrame): void {
    this.recording?.accept(frame);
  }
  async close(): Promise<void> {
    if (this.recording) await this.stop();
  }
  async start(check: () => void, by: BrowserTabActor = { kind: "agent" }): Promise<void> {
    check();
    if (this.paused()) throw new Error("Browser backend paused");
    if (this.recording) throw new Error("Recording already started");
    await this.masked(true);
    try {
      await this.begin(check, by);
    } catch (error) {
      await this.masked(false);
      throw error;
    }
  }
  private async begin(check: () => void, by: BrowserTabActor): Promise<void> {
    const recording = await Recording.start(
      join(this.options.dir, this.options.id()),
      this.options.ffmpeg,
      undefined,
      this.options.spawn,
    );
    try {
      check();
      const data = await this.options.backend.screenshot("jpeg");
      check();
      const viewport = this.options.backend.viewport();
      recording.accept({
        sequence: 0,
        timestamp: this.options.now(),
        data: data.toString("base64"),
        ...viewport,
      });
      this.recording = recording;
      this.actor = by;
    } catch (error) {
      await recording.stop().catch(() => {});
      throw error;
    }
  }
  async stop(): Promise<BrowserArtifact> {
    const recording = this.recording;
    if (!recording) throw new Error("No browser recording");
    this.recording = undefined;
    await this.masked(false);
    const artifact = await recording.stop();
    await this.options.artifact(artifact);
    return artifact;
  }
}
