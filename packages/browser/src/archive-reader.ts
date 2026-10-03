import { open, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { RandomAccessReader, fromRandomAccessReader, type ZipFile } from "yauzl";

/** yauzl's legacy fd-slicer stalls under backpressure on Node 24. Keep its ZIP
 * validation, with one owned descriptor and modern bounded range streams. */
class FileReader extends RandomAccessReader {
  private file: FileHandle;
  private signal: AbortSignal;
  constructor(file: FileHandle, signal: AbortSignal) {
    super();
    this.file = file;
    this.signal = signal;
  }
  override _readStreamForRange(start: number, end: number): Readable {
    let offset = start;
    const file = this.file;
    return new Readable({
      signal: this.signal,
      highWaterMark: 64 * 1024,
      read(size) {
        const length = Math.min(size, 64 * 1024, end - offset);
        if (length <= 0) {
          this.push(null);
          return;
        }
        const bytes = Buffer.allocUnsafe(length);
        void file.read(bytes, 0, length, offset).then(
          ({ bytesRead }) => {
            if (!bytesRead) {
              this.destroy(new Error("Truncated Chromium archive"));
              return;
            }
            offset += bytesRead;
            this.push(bytes.subarray(0, bytesRead));
          },
          (error: unknown) =>
            this.destroy(error instanceof Error ? error : new Error("Archive read failed")),
        );
      },
    });
  }
  override close(callback: (error: Error | null) => void): void {
    void this.file.close().then(
      () => callback(null),
      (error: unknown) =>
        callback(error instanceof Error ? error : new Error("Archive close failed")),
    );
  }
}

export async function openArchive(path: string, signal: AbortSignal): Promise<ZipFile> {
  signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size > 512 * 1024 * 1024)
      throw new Error("Chromium archive size limit");
    return await new Promise<ZipFile>((resolve, reject) =>
      fromRandomAccessReader(
        new FileReader(file, signal),
        size,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true },
        (error, zip) => {
          if (error || !zip) reject(error ?? new Error("Invalid Chromium archive"));
          else resolve(zip);
        },
      ),
    );
  } catch (error) {
    await file.close();
    throw error;
  }
}
