import { FilesRequestError } from "@ace/files-native";
import type { FileSearchFile, FileSearchLine } from "@ace/protocol";
import { appendLines } from "./search-hits.ts";
import type { WatchClock } from "./watch-fanout.ts";

export type SearchBatchOptions = {
  clock: WatchClock;
  /** Send one batch; never called while `ready` is false. */
  send(files: FileSearchFile[]): void;
  /** The connection can take another batch now (its queue is short). */
  ready(): boolean;
  /** How long the first line of a partial batch waits for company; 50 ms. */
  windowMs?: number | undefined;
  /** The most lines one batch carries; 200. */
  maxLines?: number | undefined;
  /** The most serialized bytes one batch carries; 32 KiB. A single larger line goes alone. */
  maxBytes?: number | undefined;
};

/** What one line adds to a batch on the wire, its path counted as if it opened a file entry. */
function lineBytes(path: string, line: FileSearchLine): number {
  return Buffer.byteLength(JSON.stringify(line)) + Buffer.byteLength(JSON.stringify(path)) + 24;
}

/**
 * A search's matches on their way to one connection: full batches (`maxLines` lines or `maxBytes`
 * serialized bytes) go at once, a partial one after `windowMs`, and nothing goes while the
 * connection's queue is long, so a slow link holds lines here instead of in the socket. A drain
 * resolves only once the connection could take another message, so the caller's final reply is
 * held back too. What waits is bounded by the search's own `maxMatches`, since every line here is
 * a match ace-files counted.
 */
export class SearchBatches {
  readonly #options: SearchBatchOptions;
  readonly #windowMs: number;
  readonly #maxLines: number;
  readonly #maxBytes: number;
  /** Batches waiting to go, the last one still filling. */
  #batches: { files: FileSearchFile[]; lines: number; bytes: number; full: boolean }[] = [];
  #stopTimer: (() => void) | undefined;
  #drained: { resolve(): void; reject(error: Error): void } | undefined;
  #closing = false;
  #cancelled = false;

  constructor(options: SearchBatchOptions) {
    this.#options = options;
    this.#windowMs = options.windowMs ?? 50;
    this.#maxLines = options.maxLines ?? 200;
    this.#maxBytes = options.maxBytes ?? 32 * 1024;
  }

  /** Queue one file's lines, splitting them so no batch passes `maxLines` or `maxBytes`. */
  add(path: string, lines: FileSearchLine[]): void {
    if (this.#cancelled || this.#closing) return;
    for (const line of lines) {
      const bytes = lineBytes(path, line);
      let open = this.#batches.at(-1);
      if (open && open.lines && open.bytes + bytes > this.#maxBytes) open.full = true;
      if (!open || open.full) {
        open = { files: [], lines: 0, bytes: 0, full: false };
        this.#batches.push(open);
      }
      appendLines(open.files, path, [line]);
      open.lines += 1;
      open.bytes += bytes;
      if (open.lines >= this.#maxLines) open.full = true;
    }
    this.#sendFull();
    this.#schedule();
  }

  /** Send what is left, resolving once the last line is out. A cancel rejects it. */
  drain(): Promise<void> {
    if (this.#cancelled) return Promise.reject(cancelled());
    this.#closing = true;
    const done = new Promise<void>((resolve, reject) => {
      this.#drained = { resolve, reject };
    });
    this.#flush();
    return done;
  }

  /** Drop every waiting line; a pending drain rejects with `CANCELLED`. */
  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#batches = [];
    this.#stopTimer?.();
    this.#stopTimer = undefined;
    const drained = this.#drained;
    this.#drained = undefined;
    drained?.reject(cancelled());
  }

  /** Full batches go as soon as the connection takes them. */
  #sendFull(): void {
    while (this.#batches.length > 1 || this.#batches[0]?.full) {
      if (!this.#options.ready()) return;
      const batch = this.#batches.shift();
      if (batch) this.#options.send(batch.files);
    }
  }

  #schedule(): void {
    if (this.#stopTimer || this.#cancelled || (!this.#batches.length && !this.#closing)) return;
    this.#stopTimer = this.#options.clock.setTimeout(() => {
      this.#stopTimer = undefined;
      this.#flush();
    }, this.#windowMs);
  }

  /** Everything waiting goes while the connection takes it; the rest tries again later. */
  #flush(): void {
    if (this.#cancelled) return;
    while (this.#batches.length && this.#options.ready()) {
      const batch = this.#batches.shift();
      if (batch?.files.length) this.#options.send(batch.files);
    }
    if (this.#batches.length) {
      this.#schedule();
      return;
    }
    if (this.#closing) {
      // The reply that follows a drain waits for room, as every batch did.
      if (!this.#options.ready()) {
        this.#schedule();
        return;
      }
      const drained = this.#drained;
      this.#drained = undefined;
      drained?.resolve();
    }
  }
}

function cancelled(): FilesRequestError {
  return new FilesRequestError("CANCELLED", "the search was cancelled");
}
