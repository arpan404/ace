import type { PtyBackend } from "./pty.ts";
import type { ExitStatus, TerminalEvent } from "./types.ts";
import { validateDimensions } from "./types.ts";

/** Authentication output is forwarded synchronously, with no ring, snapshot or replay. */
export class LiveTerminal {
  readonly pid: number;
  readonly exited: Promise<ExitStatus>;
  private backend: PtyBackend;
  private closing: Promise<void> | undefined;
  private offset = 0;
  constructor(backend: PtyBackend, emit: (event: TerminalEvent) => void) {
    this.backend = backend;
    this.pid = backend.pid;
    const stopData = backend.onData((bytes) => {
      // Bound each wire frame. Authentication clients decode the live stream.
      for (let at = 0; at < bytes.length; at += 16384) {
        const chunk = bytes.subarray(at, at + 16384);
        const offset = this.offset;
        this.offset += chunk.length;
        emit({
          type: "data",
          offset,
          endOffset: this.offset,
          data: chunk.toString("utf8"),
          truncatedBefore: false,
        });
      }
    });
    this.exited = new Promise((resolve, reject) => {
      backend.onExit((status) => {
        stopData();
        if (status instanceof Error) reject(status);
        else {
          emit({ type: "exit", status, nextOffset: this.offset });
          resolve(status);
        }
      });
    });
    void this.exited.catch(() => {});
  }
  write(data: string): void {
    this.backend.write(data);
  }
  resize(cols: number, rows: number): void {
    validateDimensions(cols, rows);
    this.backend.resize(cols, rows);
  }
  close(graceMs: number): Promise<void> {
    this.closing ??= this.backend.close(graceMs).catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    });
    return this.closing;
  }
}
