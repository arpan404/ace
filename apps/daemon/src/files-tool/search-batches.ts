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
};

/**
 * A search's matches on their way to one connection: full batches of `maxLines` go at once, a
 * partial one after `windowMs`, and nothing goes while the connection's queue is long, so a slow
 * link holds lines here instead of in the socket. What waits is bounded by the search's own
 * `maxMatches`, since every line here is a match ace-files counted.
 */
export class SearchBatches {
  readonly #options: SearchBatchOptions;
  readonly #windowMs: number;
  readonly #maxLines: number;
  /** Batches waiting to go, the last one still filling. */
  #batches: { files: FileSearchFile[]; lines: number }[] = [];
  #stopTimer: (() => void) | undefined;
  #drained: { resolve(): void; reject(error: Error): void } | undefined;
  #closing = false;
  #cancelled = false;

  constructor(options: SearchBatchOptions) {
    this.#options = options;
    this.#windowMs = options.windowMs ?? 50;
    this.#maxLines = options.maxLines ?? 200;
  }

  /** Queue one file's lines, splitting them so no batch passes `maxLines`. */
  add(path: string, lines: FileSearchLine[]): void {
    if (this.#cancelled || this.#closing) return;
    let rest = lines;
    while (rest.length) {
      let open = this.#batches.at(-1);
      if (!open || open.lines >= this.#maxLines) {
        open = { files: [], lines: 0 };
        this.#batches.push(open);
      }
      const taken = rest.slice(0, this.#maxLines - open.lines);
      rest = rest.slice(taken.length);
      appendLines(open.files, path, taken);
      open.lines += taken.length;
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
    while (this.#batches.length > 1 || (this.#batches[0]?.lines ?? 0) >= this.#maxLines) {
      if (!this.#options.ready()) return;
      const batch = this.#batches.shift();
      if (batch) this.#options.send(batch.files);
    }
  }

  #schedule(): void {
    if (this.#stopTimer || !this.#batches.length || this.#cancelled) return;
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
      const drained = this.#drained;
      this.#drained = undefined;
      drained?.resolve();
    }
  }
}

function cancelled(): FilesRequestError {
  return new FilesRequestError("CANCELLED", "the search was cancelled");
}
