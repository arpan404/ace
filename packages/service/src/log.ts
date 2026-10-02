import { Writable } from "node:stream";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
/** Backpressure reaches the child pipe; only current and previous generations exist. */
export class BoundedLog extends Writable {
  private file: FileHandle | undefined;
  private bytes = 0;
  private readonly path: string;
  private readonly cap: number;
  constructor(path: string, cap = 8 * 1024 * 1024) {
    super({ highWaterMark: 64 * 1024 });
    this.path = path;
    this.cap = cap;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid log cap");
  }
  private async ready() {
    if (!this.file) {
      this.file = await open(this.path, "a", 0o600);
      this.bytes = (await this.file.stat()).size;
    }
  }
  private async append(chunk: Buffer) {
    await this.ready();
    let offset = 0;
    while (offset < chunk.length) {
      if (this.bytes >= this.cap) {
        await this.file?.close();
        this.file = undefined;
        await rm(this.path + ".previous", { force: true });
        await rename(this.path, this.path + ".previous");
        await this.ready();
      }
      const count = Math.min(this.cap - this.bytes, chunk.length - offset);
      const written = await this.file?.write(chunk, offset, count);
      if (!written || written.bytesWritten === 0) throw new Error("Log write made no progress");
      offset += written.bytesWritten;
      this.bytes += written.bytesWritten;
    }
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    void this.append(chunk).then(
      () => callback(),
      (error) => callback(error instanceof Error ? error : new Error("Log write failed")),
    );
  }
  override _final(callback: (error?: Error | null) => void) {
    void this.file?.close().then(
      () => callback(),
      (error) => callback(error),
    );
    if (!this.file) callback();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    const file = this.file;
    this.file = undefined;
    if (file)
      void file.close().then(
        () => callback(error),
        () => callback(error),
      );
    else callback(error);
  }
}
