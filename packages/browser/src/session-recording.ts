import { join } from "node:path";
import type { BrowserFrame } from "@ace/protocol";
import { Recording } from "./recording.ts";
import type { BrowserArtifact } from "@ace/protocol";
import type { SessionOptions } from "./session-options.ts";

/** Recording owns disk/process I/O; the session supplies admission fences. */
export class SessionRecording {
  private recording: Recording | undefined;
  private options: SessionOptions;
  private paused: () => boolean;
  constructor(options: SessionOptions, paused: () => boolean) {
    this.options = options;
    this.paused = paused;
  }
  get active(): boolean {
    return this.recording !== undefined;
  }
  accept(frame: BrowserFrame): void {
    this.recording?.accept(frame);
  }
  async close(): Promise<void> {
    if (this.recording) await this.stop();
  }
  async start(check: () => void): Promise<void> {
    check();
    if (this.paused()) throw new Error("Browser backend paused");
    if (this.recording) throw new Error("Recording already started");
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
    } catch (error) {
      await recording.stop().catch(() => {});
      throw error;
    }
  }
  async stop(): Promise<BrowserArtifact> {
    const recording = this.recording;
    if (!recording) throw new Error("No browser recording");
    this.recording = undefined;
    const artifact = await recording.stop();
    await this.options.artifact(artifact);
    return artifact;
  }
}
