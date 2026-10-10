import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ScreenId } from "@ace/protocol";
import type { Frame } from "./frames.ts";
export type RecordingArtifact = {
  id: string;
  path: string;
  bytes: number;
  mimeType: "application/vnd.ace.screen";
};
export class Recording {
  private bytes = 0;
  private reason: "limit" | "error" | undefined;
  private failure: Error | undefined;
  private closing: Promise<RecordingArtifact> | undefined;
  private pending: Frame | undefined;
  private busy = false;
  private drained: (() => void) | undefined;
  private readonly stream: WriteStream;
  private readonly path: string;
  private readonly id: string;
  private readonly limit: number;
  private readonly captureDone: (reason?: "limit" | "error") => void;
  private readonly publish: (artifact: RecordingArtifact) => Promise<void>;
  private constructor(
    path: string,
    id: string,
    limit: number,
    publish: (artifact: RecordingArtifact) => Promise<void>,
    captureDone: (reason?: "limit" | "error") => void,
  ) {
    this.path = path;
    this.id = id;
    this.limit = limit;
    this.publish = publish;
    this.captureDone = captureDone;
    this.stream = createWriteStream(path, { flags: "wx", mode: 0o600, highWaterMark: 64 * 1024 });
    this.stream.on("error", (error) => {
      this.failure = error;
      this.captureDone("error");
      this.pending = undefined;
      this.busy = false;
      this.drained?.();
    });
  }
  static async open(
    directory: string,
    id: string,
    publish: (artifact: RecordingArtifact) => Promise<void>,
    limit = 50 * 1024 * 1024,
    captureDone: (reason?: "limit" | "error") => void = () => {},
  ): Promise<Recording> {
    ScreenId.parse(id);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid recording limit");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const recording = new Recording(
      join(directory, `${id}.ace-screen`),
      id,
      limit,
      publish,
      captureDone,
    );
    await new Promise<void>((resolve, reject) => {
      recording.stream.once("open", () => resolve());
      recording.stream.once("error", reject);
    });
    return recording;
  }
  push(frame: Frame): void {
    if (this.closing || this.failure) return;
    if (this.busy) this.pending = frame;
    else this.write(frame);
  }
  private write(frame: Frame): void {
    if (this.bytes + frame.packet.length > this.limit) {
      this.pending = undefined;
      this.busy = false;
      this.drained?.();
      this.reason = "limit";
      void this.stop().catch(() => {});
      return;
    }
    this.busy = true;
    this.bytes += frame.packet.length;
    this.stream.write(frame.packet, (error) => {
      if (error) this.failure = error;
      this.busy = false;
      const pending = this.pending;
      this.pending = undefined;
      if (pending && !this.failure) this.write(pending);
      else this.drained?.();
    });
  }
  stop(): Promise<RecordingArtifact> {
    this.closing ??= (async () => {
      this.captureDone(this.reason);
      if (this.busy)
        await new Promise<void>((resolve) => {
          this.drained = resolve;
        });
      if (!this.stream.destroyed) await new Promise<void>((resolve) => this.stream.end(resolve));
      if (this.failure) {
        await unlink(this.path).catch(() => {});
        throw this.failure;
      }
      const artifact: RecordingArtifact = {
        id: this.id,
        path: this.path,
        bytes: this.bytes,
        mimeType: "application/vnd.ace.screen",
      };
      await this.publish(artifact);
      return artifact;
    })();
    return this.closing;
  }
}
