import { LruCache } from "@ace/ui-core";
import type { MarkdownBlock, MarkdownDoc } from "./blocks.ts";
import type { StreamJob, StreamReply } from "./stream-registry.ts";

/*
 * Rendered markdown per stream (a message, or a fixed text), built in the markdown worker. A
 * stream sends the worker only the text appended since its last job and keeps the blocks that
 * settled, so a growing answer costs work proportional to what changed. One job is in flight
 * per stream, always for the newest text. While a message streams its jobs are paced (the
 * first goes at once, so the first words show with no delay); a final one goes at once.
 */

export interface MarkdownBackend {
  /** Whether jobs run in a worker; otherwise `local` runs them in place. */
  parallel: boolean;
  run(job: StreamJob): Promise<StreamReply>;
  local(job: StreamJob): StreamReply;
  /** Drop the worker's parser for a stream no view shows any more. */
  release(stream: string): void;
}

export interface MarkdownStoreOptions {
  backend: MarkdownBackend;
  now(): number;
  schedule(delayMs: number, run: () => void): () => void;
  /** Milliseconds between two updates of a streaming message, given the last one's cost. */
  interval(lastMs: number): number;
  /** Told of each update: the text's length and the worker's time. */
  updated?(update: { stream: string; chars: number; ms: number }): void;
  /** What unwatched documents may hold, in UTF-16 units weighed as `park` does (16 Mi). */
  parkedWeight?: number;
}

interface Wanted {
  text: string;
  final: boolean;
}

interface Stream {
  key: string;
  /** The text the worker holds for this stream, and whether it was final. */
  sent: Wanted | undefined;
  wanted: Wanted | undefined;
  settled: MarkdownBlock[];
  doc: MarkdownDoc | undefined;
  busy: boolean;
  failures: number;
  /** Cancels the paced job waiting for its turn. */
  waiting: (() => void) | undefined;
  /** When the next paced job may go. */
  readyAt: number;
  listeners: Set<() => void>;
  /** Bumped when the stream is parked: replies to jobs sent before then are ignored. */
  epoch: number;
  /** What a parked stream holds, in UTF-16 units (texts and blocks), for the cache's budget. */
  weight: number;
}

/** Characters a document's blocks hold; their token trees cost about three times that. */
const docChars = (doc: MarkdownDoc | undefined) =>
  doc ? doc.blocks.reduce((sum, block) => sum + block.token.raw.length, 0) : 0;

export class MarkdownStore {
  private options: MarkdownStoreOptions;
  private live = new Map<string, Stream>();
  /**
   * Streams no view watches: enough for every message a person scrolls back through in a
   * session, so a row that mounts again shows its blocks at once.
   */
  private parked: LruCache<string, Stream>;
  constructor(options: MarkdownStoreOptions) {
    this.options = options;
    this.parked = new LruCache<string, Stream>({
      maxEntries: 400,
      maxWeight: options.parkedWeight ?? 16 * 1024 * 1024,
      weigh: (stream) => stream.weight,
    });
  }
  /** Whether documents are built in a worker; otherwise they are built in place. */
  get parallel(): boolean {
    return this.options.backend.parallel;
  }
  watch(key: string, listener: () => void): () => void {
    const stream = this.stream(key);
    stream.listeners.add(listener);
    return () => {
      stream.listeners.delete(listener);
      if (!stream.listeners.size && this.live.get(key) === stream) this.park(stream);
    };
  }
  /**
   * No view shows the stream: cancel what is queued, ignore replies still on their way, and
   * free the worker's parser unless the text was final (a final job already did). The parked
   * stream never changes again, so its weight holds.
   */
  private park(stream: Stream): void {
    this.live.delete(stream.key);
    stream.waiting?.();
    stream.waiting = undefined;
    stream.wanted = undefined;
    stream.epoch++;
    if (stream.busy || !stream.sent?.final) {
      if (stream.sent || stream.busy) this.options.backend.release(stream.key);
      stream.busy = false;
      stream.sent = undefined;
    }
    stream.weight = (stream.sent?.text.length ?? 0) + docChars(stream.doc) * 3 + 256;
    this.parked.set(stream.key, stream);
  }
  /** The document to show: the newest one built for this stream. */
  read(key: string): MarkdownDoc | undefined {
    return (this.live.get(key) ?? this.parked.get(key))?.doc;
  }
  /** Ask for `text`'s document in this stream; `final` once no more text will come. */
  want(key: string, text: string, final: boolean): void {
    const stream = this.stream(key);
    stream.wanted = { text, final };
    this.pump(stream);
  }
  private stream(key: string): Stream {
    let stream = this.live.get(key) ?? this.parked.get(key);
    if (!stream) {
      stream = {
        key,
        sent: undefined,
        wanted: undefined,
        settled: [],
        doc: undefined,
        busy: false,
        failures: 0,
        waiting: undefined,
        readyAt: 0,
        listeners: new Set(),
        epoch: 0,
        weight: 0,
      };
    }
    this.parked.delete(key);
    this.live.set(key, stream);
    return stream;
  }
  private pump(stream: Stream): void {
    const wanted = stream.wanted;
    // The final text never waits for the pace.
    if (wanted?.final && stream.waiting) {
      stream.waiting();
      stream.waiting = undefined;
    }
    if (stream.busy || stream.waiting || !wanted) return;
    const sent = stream.sent;
    if (sent && sent.final === wanted.final && sent.text === wanted.text) {
      stream.wanted = undefined;
      return;
    }
    // Nothing to show yet: the view shows the empty text itself.
    if (!wanted.text && !sent) return;
    const now = this.options.now();
    // Until something shows, and once the text is final, no waiting.
    if (!wanted.final && stream.doc?.blocks.length && now < stream.readyAt) {
      stream.waiting = this.options.schedule(stream.readyAt - now, () => {
        stream.waiting = undefined;
        this.pump(stream);
      });
      return;
    }
    stream.wanted = undefined;
    // Appended text goes alone; anything else (a rewrite, a stream the worker lost) whole.
    const appended = sent && wanted.text.startsWith(sent.text) ? sent.text.length : 0;
    const job: StreamJob = {
      stream: stream.key,
      at: appended,
      append: appended ? wanted.text.slice(appended) : wanted.text,
      final: wanted.final,
    };
    stream.sent = wanted;
    const { backend } = this.options;
    if (!backend.parallel) {
      this.answer(stream, wanted, backend.local(job), now);
      return;
    }
    stream.busy = true;
    const epoch = stream.epoch;
    void backend.run(job).then(
      (reply) => {
        if (stream.epoch !== epoch) return;
        stream.busy = false;
        this.answer(stream, wanted, reply, now);
      },
      () => {
        if (stream.epoch !== epoch) return;
        stream.busy = false;
        // The worker failed (it restarts on the next job): send the text whole, once more.
        stream.sent = undefined;
        if (++stream.failures > 1) return;
        stream.wanted ??= wanted;
        this.pump(stream);
      },
    );
  }
  private answer(stream: Stream, wanted: Wanted, reply: StreamReply, started: number): void {
    if ("resync" in reply) {
      stream.sent = undefined;
      stream.wanted ??= wanted;
      this.pump(stream);
      return;
    }
    stream.failures = 0;
    stream.settled.length = Math.min(stream.settled.length, reply.from);
    for (const block of reply.settled) stream.settled.push(block);
    stream.doc = {
      blocks: reply.open.length ? stream.settled.concat(reply.open) : stream.settled.slice(),
      settled: stream.settled.length,
    };
    const now = this.options.now();
    stream.readyAt = started + this.options.interval(now - started);
    this.options.updated?.({ stream: stream.key, chars: wanted.text.length, ms: reply.ms });
    for (const listener of stream.listeners) listener();
    this.pump(stream);
  }
}
